import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewResponse } from './types';

vi.mock('#imports', () => ({ defineBackground: (main: () => void) => ({ main }) }));

type Listener = (
  message: { type: string; url?: string; requestId?: number },
  sender: { id: string; tab: { id: number; url: string } },
  respond: (response: PreviewResponse) => void,
) => boolean;

const fetchMock = vi.fn<typeof fetch>();
const addListener = vi.fn<(listener: Listener) => void>();
const origin = 'https://destination.example.com';

function redirectResponse() {
  // Browsers filter manual redirects to status 0 without a readable Location header.
  const response = Response.error();
  Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
  return response;
}

function htmlResponse() {
  return new Response('<title>TestFlight beta</title>', { headers: { 'content-type': 'text/html' } });
}

function preview(url: string, requestId?: number, source = 'https://source.example.com', tabId = 1): Promise<PreviewResponse> {
  const listener = addListener.mock.calls[0]?.[0];
  if (!listener) throw new Error('Missing preview message listener');
  return new Promise(resolve => {
    listener(
      { type: 'PEEKLINK_PREVIEW', url, requestId },
      { id: 'peeklink', tab: { id: tabId, url: source } },
      resolve,
    );
  });
}

function cancel(requestId: number): void {
  const listener = addListener.mock.calls[0]?.[0];
  listener?.(
    { type: 'PEEKLINK_CANCEL', requestId },
    { id: 'peeklink', tab: { id: 1, url: 'https://source.example.com' } },
    () => undefined,
  );
}

function onRemoved(): ((permissions: { origins?: string[]; permissions?: string[] }) => void) | undefined {
  return vi.mocked(chrome.permissions.onRemoved.addListener).mock.calls[0]?.[0];
}

function tabRemoved(tabId: number): void {
  vi.mocked(chrome.tabs.onRemoved.addListener).mock.calls[0]?.[0]?.(tabId, { windowId: 1, isWindowClosing: false });
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue({ origins: [] }),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: { getRegisteredContentScripts: vi.fn().mockResolvedValue([]) },
    runtime: { id: 'peeklink', onMessage: { addListener } },
    tabs: { onRemoved: { addListener: vi.fn() } },
    action: { onClicked: { addListener: vi.fn() } },
  });
  const { default: background } = await import('../entrypoints/background');
  background.main();
});

afterEach(() => vi.unstubAllGlobals());

describe('preview requests', () => {
  it('previews slash-normalized URLs and retains the query and shared request deadline', async () => {
    fetchMock.mockResolvedValueOnce(redirectResponse()).mockResolvedValueOnce(htmlResponse());
    const input = `${origin}/testflight?lang=en#beta`;
    const target = `${origin}/testflight/?lang=en`;

    const result = await preview(input);
    expect(result).toMatchObject({ ok: true, data: { title: 'TestFlight beta', url: target } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${origin}/testflight?lang=en`, expect.objectContaining({ redirect: 'manual' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, target, expect.objectContaining({ redirect: 'manual', signal }));

    expect(await preview(input)).toEqual(result);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stops after one slash probe when the alternate URL redirects too', async () => {
    fetchMock.mockImplementation(async () => redirectResponse());
    expect(await preview(`${origin}/testflight/`)).toMatchObject({ ok: false, code: 'redirect' });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([`${origin}/testflight/`, `${origin}/testflight`]);
  });

  it('allows the next hover to recover immediately after a transient failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(htmlResponse());
    const url = `${origin}/testflight`;
    expect(await preview(url)).toMatchObject({ ok: false, code: 'network' });
    expect(await preview(url)).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('applies a mid-flight revocation to shared waiters and skips the cache write', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));
    let targetGranted = true;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(!origins.includes('https://destination.example.com/*') || targetGranted));

    const url = `${origin}/testflight`;
    const first = preview(url, 1);
    const second = preview(url, 2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    targetGranted = false;
    resolvers[0]?.(htmlResponse());

    expect(await first).toMatchObject({ ok: false, code: 'permission' });
    expect(await second).toMatchObject({ ok: false, code: 'permission' });

    // Restoring access must refetch: the revoked flight never reached the cache.
    targetGranted = true;
    const third = preview(url, 3);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolvers[1]?.(htmlResponse());
    expect(await third).toMatchObject({ ok: true });
  });

  it('aborts an in-flight request when its last waiter cancels', async () => {
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    });

    const result = preview(`${origin}/testflight`, 5);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    cancel(5);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('drops a cancelled request from the queue without running it', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));

    const running = [0, 1, 2, 3].map(i => preview(`${origin}/running-${i}`, i + 1));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const queued = preview(`${origin}/queued`, 9);
    await tick();
    cancel(9);

    expect(await queued).toMatchObject({ ok: false, code: 'cancelled' });
    resolvers.forEach(resolve => resolve(htmlResponse()));
    for (const request of running) expect(await request).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('evicts cached previews when the destination grant is removed', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));
    const url = `${origin}/testflight`;
    expect(await preview(url)).toMatchObject({ ok: true });

    onRemoved()?.({ origins: [`${origin}/*`], permissions: [] });

    expect(await preview(url)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('evicts port-qualified and trailing-dot origins precisely on revocation', async () => {
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));
    const dotted = 'https://example.com./page';
    const ported = 'https://example.com:8443/page';
    expect(await preview(dotted)).toMatchObject({ ok: true });
    expect(await preview(ported)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // A different port and an unrelated host must not evict.
    onRemoved()?.({ origins: ['https://example.com:9999/*', 'https://unrelated.example.org/*'], permissions: [] });
    expect(await preview(ported)).toMatchObject({ ok: true });
    expect(await preview(dotted)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The port-qualified grant alone must evict only its own entry.
    onRemoved()?.({ origins: ['https://example.com:8443/*'], permissions: [] });
    expect(await preview(ported)).toMatchObject({ ok: true });
    expect(await preview(dotted)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The portless grant then evicts the trailing-dot entry.
    onRemoved()?.({ origins: ['https://example.com/*'], permissions: [] });
    expect(await preview(dotted)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('abandons a request cancelled during the source permission check', async () => {
    let releaseSource: (granted: boolean) => void = () => undefined;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => origins.includes('https://source.example.com/*')
      ? new Promise<boolean>(resolve => { releaseSource = resolve; })
      : Promise.resolve(true));

    const result = preview(`${origin}/testflight`, 11);
    cancel(11);
    releaseSource(true);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('abandons a request cancelled during the destination permission check', async () => {
    const destResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => origins.includes('https://destination.example.com/*')
      ? new Promise<boolean>(resolve => { destResolvers.push(resolve); })
      : Promise.resolve(true));

    const result = preview(`${origin}/testflight`, 12);
    await vi.waitFor(() => expect(destResolvers).toHaveLength(1));
    cancel(12);
    destResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('honors a cancel received during the final destination recheck', async () => {
    const destResolvers: Array<(granted: boolean) => void> = [];
    let destCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://destination.example.com/*')) return Promise.resolve(true);
      destCalls += 1;
      return destCalls <= 2 ? Promise.resolve(true) : new Promise<boolean>(resolve => { destResolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 41);
    await vi.waitFor(() => expect(destCalls).toBe(3));
    cancel(41);
    destResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('keeps a shared request alive when only one of two waiters cancels', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const url = `${origin}/testflight`;
    const first = preview(url, 21);
    const second = preview(url, 22);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    cancel(21);
    release(htmlResponse());

    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await second).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels an in-flight request when the source page grant is removed', async () => {
    const granted = new Set(['https://source.example.com/*', 'https://destination.example.com/*']);
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(origins.every(o => granted.has(o))));
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const result = preview(`${origin}/testflight`, 31);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    granted.delete('https://source.example.com/*');
    onRemoved()?.({ origins: ['https://source.example.com/*'], permissions: [] });

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('keeps a shared request alive for waiters whose source grants remain', async () => {
    const revoked = new Set<string>();
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(!origins.some(o => revoked.has(o))));
    let release: (response: Response) => void = () => undefined;
    let requestSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((_url, init) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        release = resolve;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const url = `${origin}/testflight`;
    const first = preview(url, 21, 'https://a.example.com/page');
    const second = preview(url, 22, 'https://b.example.com/page');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    revoked.add('https://a.example.com/*');
    onRemoved()?.({ origins: ['https://a.example.com/*'], permissions: [] });

    // The revoked waiter resolves while the shared fetch is still pending.
    expect(await first).toMatchObject({ ok: false, code: 'permission' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);

    // Restoring the grant must not revive the detached waiter.
    revoked.delete('https://a.example.com/*');
    release(htmlResponse());

    expect(await second).toMatchObject({ ok: true });
  });

  it('denies a request whose source grant is revoked during the destination check', async () => {
    const revoked = new Set<string>();
    const destResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (origins.includes('https://destination.example.com/*')) {
        return new Promise<boolean>(resolve => { destResolvers.push(resolve); });
      }
      return Promise.resolve(!origins.some(o => revoked.has(o)));
    });

    const result = preview(`${origin}/testflight`, 13);
    await vi.waitFor(() => expect(destResolvers).toHaveLength(1));
    revoked.add('https://source.example.com/*');
    onRemoved()?.({ origins: ['https://source.example.com/*'], permissions: [] });
    destResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns cancelled when a cancel lands during the final source recheck', async () => {
    const resolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { resolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 51);
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    cancel(51);
    resolvers[0]?.(false);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('denies a request whose source recheck resolves without the grant', async () => {
    const resolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { resolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 52);
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    resolvers[0]?.(false);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
  });

  it('denies delivery when the destination grant is removed during the final recheck', async () => {
    const revoked = new Set<string>();
    const sourceResolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) {
        return Promise.resolve(!origins.some(o => revoked.has(o)));
      }
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { sourceResolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 61);
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    revoked.add('https://destination.example.com/*');
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    sourceResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
  });

  it('denies a request whose destination grant is revoked during its admission check', async () => {
    const revoked = new Set<string>();
    const destResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (origins.includes('https://destination.example.com/*')) {
        return new Promise<boolean>(resolve => { destResolvers.push(resolve); });
      }
      return Promise.resolve(!origins.some(o => revoked.has(o)));
    });

    const result = preview(`${origin}/testflight`, 62);
    await vi.waitFor(() => expect(destResolvers).toHaveLength(1));
    revoked.add('https://destination.example.com/*');
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    destResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns cancelled when a cancel lands during a failing destination admission check', async () => {
    const destResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      origins.includes('https://destination.example.com/*')
        ? new Promise<boolean>(resolve => { destResolvers.push(resolve); })
        : Promise.resolve(true));

    const result = preview(`${origin}/testflight`, 63);
    await vi.waitFor(() => expect(destResolvers).toHaveLength(1));
    cancel(63);
    destResolvers[0]?.(false);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('denies a request whose destination grant is revoked during the source check', async () => {
    const revoked = new Set<string>();
    const sourceResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (origins.includes('https://source.example.com/*')) {
        return new Promise<boolean>(resolve => { sourceResolvers.push(resolve); });
      }
      return Promise.resolve(!origins.some(o => revoked.has(o)));
    });

    const result = preview(`${origin}/testflight`, 64);
    await vi.waitFor(() => expect(sourceResolvers).toHaveLength(1));
    revoked.add('https://destination.example.com/*');
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    // Restoring the grant must not revive the settled request.
    revoked.delete('https://destination.example.com/*');
    sourceResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a live cancellation over revocation and tombstone churn', async () => {
    const sourceResolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { sourceResolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 80);
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    cancel(80);
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    for (let i = 0; i < 520; i++) cancel(10_000 + i);
    sourceResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('keeps a revocation settlement over a later cancellation', async () => {
    const sourceResolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { sourceResolvers.push(resolve); });
    });
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    const result = preview(`${origin}/testflight`, 81);
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    cancel(81);
    sourceResolvers[0]?.(true);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
  });

  it('evicts stray cancel tombstones beyond the cap while keeping live state', async () => {
    cancel(900);
    for (let i = 0; i < 520; i++) cancel(1000 + i);
    fetchMock.mockImplementation(() => Promise.resolve(htmlResponse()));

    // The stray tombstone for request 900 was evicted — a real request proceeds.
    expect(await preview(`${origin}/testflight`, 900)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued preview when its tab closes', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));

    const running = [0, 1, 2, 3].map(i => preview(`${origin}/run-${i}`, i + 1, 'https://source.example.com', 2));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    const queued = preview(`${origin}/queued`, 9);
    await tick();

    tabRemoved(1);
    resolvers.forEach(resolve => resolve(htmlResponse()));

    for (const request of running) expect(await request).toMatchObject({ ok: true });
    expect(await queued).toMatchObject({ ok: false, code: 'cancelled' });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('keeps a shared fetch alive for waiters in still-open tabs', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation((_url, init) => new Promise<Response>((resolve, reject) => {
      release = resolve;
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));

    const first = preview(`${origin}/shared`, 1);
    const second = preview(`${origin}/shared`, 2, 'https://other.example.com', 11);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    tabRemoved(1);
    release(htmlResponse());

    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });
    expect(await second).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a duplicate live request ID from the same document', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));

    const first = preview(`${origin}/first`, 71);
    const duplicate = preview(`${origin}/second`, 71);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    release(htmlResponse());

    expect(await first).toMatchObject({ ok: true });
    expect(await duplicate).toMatchObject({ ok: false, code: 'unavailable' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('tolerates a response callback that throws on the duplicate-ID path', async () => {
    let release: (response: Response) => void = () => undefined;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { release = resolve; }));
    const listener = addListener.mock.calls[0]?.[0];
    if (!listener) throw new Error('Missing preview message listener');

    const first = preview(`${origin}/first`, 71);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const accepted = listener(
      { type: 'PEEKLINK_PREVIEW', url: `${origin}/second`, requestId: 71 },
      { id: 'peeklink', tab: { id: 1, url: 'https://source.example.com' } },
      () => { throw new Error('channel gone'); },
    );
    expect(accepted).toBe(false);
    release(htmlResponse());
    expect(await first).toMatchObject({ ok: true });

    fetchMock.mockResolvedValueOnce(htmlResponse());
    expect(await preview(`${origin}/later`, 71)).toMatchObject({ ok: true });
  });

  it('tolerates a response callback that throws after delivery', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse());
    const listener = addListener.mock.calls[0]?.[0];
    if (!listener) throw new Error('Missing preview message listener');
    listener(
      { type: 'PEEKLINK_PREVIEW', url: `${origin}/gone`, requestId: 88 },
      { id: 'peeklink', tab: { id: 1, url: 'https://source.example.com' } },
      () => { throw new Error('channel gone'); },
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await tick();
    await tick();

    fetchMock.mockResolvedValueOnce(htmlResponse());
    expect(await preview(`${origin}/gone-later`, 88)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('times out a queued request that waits too long for a slot', async () => {
    vi.useFakeTimers();
    try {
      const resolvers: Array<(response: Response) => void> = [];
      fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));
      const flush = () => vi.advanceTimersByTimeAsync(0);

      const running = [0, 1, 2, 3].map(i => preview(`${origin}/running-${i}`, i + 1));
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(4);

      const queued = preview(`${origin}/queued`, 9);
      await flush();
      await vi.advanceTimersByTimeAsync(15_000);

      await expect(queued).resolves.toMatchObject({ ok: false, code: 'timeout' });
      resolvers.forEach(resolve => resolve(htmlResponse()));
      await flush();
      for (const request of running) expect(await request).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors a UTF-8 BOM over a conflicting content-type charset', async () => {
    const bytes = new Uint8Array([0xEF, 0xBB, 0xBF, ...new TextEncoder().encode('<title>café</title>')]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=gbk' } }));
    expect(await preview(`${origin}/bom`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('sniffs a meta charset declaration for non-UTF-8 pages', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/gbk`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('ignores non-declaration charset strings in tags, attributes, and comments', async () => {
    const bytes = new TextEncoder().encode(
      '<!-- <meta charset=gbk> --><meta-data charset=gbk><div title="<meta charset=gbk>"></div>'
      + '<meta name="charset=gbk"><meta data-charset=gbk><title>café</title>',
    );
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/dc`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('ignores similarly named charset parameters in the content-type header', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; x-charset=gbk' } }));
    expect(await preview(`${origin}/xcs`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('ignores charset strings inside a quoted header parameter value', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; note="a; charset=gbk; b"' } }));
    expect(await preview(`${origin}/qhdr`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('keeps an escaped quote inside a quoted header value from fabricating charset', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; note="a\\"; charset=gbk; b"' } }));
    expect(await preview(`${origin}/esc`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('unescapes quoted pairs inside a charset label', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset="g\\bk"' } }));
    expect(await preview(`${origin}/uql`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('honors a real charset after an apostrophe-leading parameter value', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': "text/html; note='foo; charset=gbk" } }));
    expect(await preview(`${origin}/apos`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('skips an unsupported header charset and keeps sniffing meta declarations', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=unknown-encoding' } }));
    expect(await preview(`${origin}/ucsup`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('skips an unsupported meta charset in favor of a later valid one', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=unknown-encoding><meta charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/ucmeta`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('does not treat a longer tag name with a meta prefix as a meta tag', async () => {
    const bytes = new TextEncoder().encode('<meta.widget-box charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/tagname`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('keeps the first of duplicate meta attributes', async () => {
    const bytes = new TextEncoder().encode('<meta charset=utf-8 charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/dupattr`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('maps the unicode meta alias to utf-8 per the HTML prescan', async () => {
    const bytes = new TextEncoder().encode('<meta charset=unicode><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/unicode`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('maps x-user-defined to windows-1252 per the HTML prescan', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=x-user-defined><title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/xud`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('reads a single-quoted charset inside a meta content declaration', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(`<meta http-equiv="content-type" content="text/html; charset='gbk'"><title>`),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/sq`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('does not treat a non-breaking space as a tag-name delimiter', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta'),
      0xA0,
      ...new TextEncoder().encode('charset=gbk><title>café</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/nbsp`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not meta-sniff XML documents', async () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0"?><root><script>//<![CDATA[ <meta charset=gbk> ]]></script><title>café</title></root>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xhtml`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('honors the encoding pseudo-attribute of an XML declaration', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"?><root><title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title></root>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xmlenc`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('remaps the ucs-2 meta alias to utf-8 before a later declaration', async () => {
    const bytes = new TextEncoder().encode('<meta charset=ucs-2><meta charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/ucs2`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('remaps the unicodefffe content alias to utf-8 before a later declaration', async () => {
    const bytes = new TextEncoder().encode('<meta http-equiv="content-type" content="text/html; charset=unicodefffe"><meta charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/ufffe`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips an unresolvable meta charset label instead of remapping it', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=utf-16bogus><meta charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/bogus`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('does not trim non-ASCII whitespace before an HTTP charset parameter name', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html;\u00A0charset=gbk' } }));
    expect(await preview(`${origin}/nbsp-hdr`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not trim a non-ASCII byte inside a quoted meta charset label', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(`<meta http-equiv="content-type" content="text/html; charset='gbk`),
      0xA0,
      ...new TextEncoder().encode(`'"><title>café</title>`),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/nbsp-label`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not split an attribute name on an embedded quote', async () => {
    const bytes = new TextEncoder().encode('<meta data-x"charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/qname`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('lets a markup declaration consume a nested meta tag', async () => {
    const bytes = new TextEncoder().encode('<!ignored <meta charset=gbk>><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/decl`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('honors quoted attribute boundaries inside an end tag', async () => {
    const bytes = new TextEncoder().encode('</div data-note="> <meta charset=gbk>"><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/etag`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('treats a leading equals sign as part of an attribute name', async () => {
    const bytes = new TextEncoder().encode('<meta =charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/eqattr`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('requires a complete XML declaration to read its encoding', async () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0" encoding="windows-1252"<root><title>café</title></root>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xmlopen`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not read encoding inside a quoted XML pseudo-attribute value', async () => {
    const bytes = new TextEncoder().encode(`<?xml version='1.0 encoding="windows-1252"'?><root><title>café</title></root>`);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xmlq`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('matches the XML encoding pseudo-attribute case-sensitively', async () => {
    const bytes = new TextEncoder().encode('<?xml version="1.0" ENCODING="windows-1252"?><root><title>café</title></root>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xmlcap`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('detects BOM-less UTF-16LE XHTML via byte-order signatures', async () => {
    const text = '<?xml version="1.0"?><root><title>café</title></root>';
    const bytes = new Uint8Array(new Uint16Array([...text].map(c => c.charCodeAt(0))).buffer);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/u16le`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('detects BOM-less UTF-16BE XHTML via byte-order signatures', async () => {
    const text = '<?xml version="1.0"?><root><title>café</title></root>';
    const bytes = new Uint8Array([...text].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xFF]));
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/u16be`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not match data-encoding as the XML encoding pseudo-attribute', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<?xml version="1.0" data-encoding="windows-1252"?><root><title>caf'),
      0xC3, 0xA9,
      ...new TextEncoder().encode('</title></root>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/xmldata`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('ignores a fake meta tag nested in a quoted attribute containing >', async () => {
    const bytes = new TextEncoder().encode('<div title="a > <meta charset=gbk>"></div><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/qtag`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('stops scanning when a quoted attribute is left unclosed', async () => {
    const bytes = new TextEncoder().encode('<div title="abc<meta charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/unclosed`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('treats <!--> as a closed comment per the prescan rules', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<!--><meta charset=windows-1252><title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/cmt`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not open quoting after whitespace inside a header value', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; foo= "a; charset=windows-1252' } }));
    expect(await preview(`${origin}/wspq`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('ignores text after a closed quoted header value through the semicolon', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset="windows-1252"junk' } }));
    expect(await preview(`${origin}/qjunk`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('lets an unresolvable meta charset attribute shadow the same tag’s http-equiv', async () => {
    const bytes = new TextEncoder().encode('<meta charset=bogus http-equiv=content-type content="text/html; charset=windows-1252"><meta charset=utf-8><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/shadow`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('treats quotes after a space in a header value as literal, not quoting', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset= "gbk"' } }));
    expect(await preview(`${origin}/spq`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips a bare charset parameter before applying first-parameter precedence', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset; charset=windows-1252' } }));
    expect(await preview(`${origin}/bare`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips an empty unquoted charset parameter before applying first-parameter precedence', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=; charset=windows-1252' } }));
    expect(await preview(`${origin}/empty`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips a whitespace-only unquoted charset parameter', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=  ; charset=windows-1252' } }));
    expect(await preview(`${origin}/wsonly`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips a quoted charset parameter containing a DEL byte', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset="utf-8\x7f"; charset=windows-1252' } }));
    expect(await preview(`${origin}/delbyte`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('skips an unquoted charset parameter containing a space', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=g bk; charset=windows-1252' } }));
    expect(await preview(`${origin}/sptok`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('accepts an unquoted charset with trailing whitespace before the next parameter', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=windows-1252 ; format=flowed' } }));
    expect(await preview(`${origin}/trail`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('trims leading whitespace in an unquoted charset label during lookup', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset= \tgbk' } }));
    expect(await preview(`${origin}/leadto`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('keeps the detected byte order when an XML declaration says generic UTF-16', async () => {
    const text = '<?xml version="1.0" encoding="UTF-16"?><root><title>café</title></root>';
    const bytes = new Uint8Array([...text].flatMap(c => [c.charCodeAt(0) >> 8, c.charCodeAt(0) & 0xFF]));
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'application/xhtml+xml' } }));
    expect(await preview(`${origin}/u16gen`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('lets the first charset parameter win even when its value is unusable', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=""; charset=windows-1252' } }));
    expect(await preview(`${origin}/dupcs`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('rejects a charset parameter name with whitespace before the equals sign', async () => {
    const bytes = new TextEncoder().encode('<title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset =windows-1252' } }));
    expect(await preview(`${origin}/wseq`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('collects an unclosed quoted header value through end of input', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset="windows-1252' } }));
    expect(await preview(`${origin}/uq`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not reopen value quoting on a second equals sign in a header', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<title>caf'),
      0xE9,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; foo=a="; charset=windows-1252' } }));
    expect(await preview(`${origin}/eq2`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('honors a real meta charset whose earlier attribute contains a comment opener', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta data-note="<!--" charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title><!-- -->'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/cattr`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('treats an unclosed comment as running to the end of the sniff buffer', async () => {
    const bytes = new TextEncoder().encode('<!-- <meta charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/ucmt`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('does not read a dotted attribute name as a charset declaration', async () => {
    const bytes = new TextEncoder().encode('<meta data-preview.charset=gbk><title>café</title>');
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/dotted`)).toMatchObject({ ok: true, data: { title: 'café' } });
  });

  it('honors a real meta charset after an unquoted attribute containing an apostrophe', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode("<meta data-name=don't charset=gbk><title>"),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/tapos`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('falls through a whitespace-only charset parameter to meta sniffing', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta charset=gbk><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html; charset=" "' } }));
    expect(await preview(`${origin}/ws`)).toMatchObject({ ok: true, data: { title: '中' } });
  });

  it('reads charset from an http-equiv content-type meta declaration', async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode('<meta http-equiv="Content-Type" content="text/html; charset=gbk"><title>'),
      0xD6, 0xD0,
      ...new TextEncoder().encode('</title>'),
    ]);
    fetchMock.mockResolvedValueOnce(new Response(bytes, { headers: { 'content-type': 'text/html' } }));
    expect(await preview(`${origin}/equiv`)).toMatchObject({ ok: true, data: { title: '中' } });
  });
});
