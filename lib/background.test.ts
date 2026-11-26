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
let redirectListener: ((details: chrome.webRequest.WebResponseHeadersDetails) => void) | undefined;

function emitRedirect(url: string, redirectUrl: string, initiator = 'chrome-extension://peeklink'): void {
  redirectListener?.({
    url,
    statusCode: 302,
    responseHeaders: [{ name: 'location', value: redirectUrl }],
    timeStamp: Date.now(),
    method: 'GET',
    type: 'xmlhttprequest',
    tabId: -1,
    initiator,
  } as chrome.webRequest.WebResponseHeadersDetails);
}

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
  const listener = addListener.mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Missing preview message listener');
  return new Promise(resolve => {
    listener(
      { type: 'PEEKLINK_PREVIEW', url, requestId },
      { id: 'peeklink', tab: { id: tabId, url: source } },
      resolve,
    );
  });
}

function prefetch(url: string, requestId?: number, source = 'https://source.example.com', tabId = 1): Promise<PreviewResponse> {
  const listener = addListener.mock.calls.at(-1)?.[0];
  if (!listener) throw new Error('Missing preview message listener');
  return new Promise(resolve => {
    listener(
      { type: 'PEEKLINK_PREFETCH', url, requestId },
      { id: 'peeklink', tab: { id: tabId, url: source } },
      resolve,
    );
  });
}

function cancel(requestId: number): void {
  const listener = addListener.mock.calls.at(-1)?.[0];
  listener?.(
    { type: 'PEEKLINK_CANCEL', requestId },
    { id: 'peeklink', tab: { id: 1, url: 'https://source.example.com' } },
    () => undefined,
  );
}

function onRemoved(): ((permissions: { origins?: string[]; permissions?: string[] }) => void) | undefined {
  return vi.mocked(chrome.permissions.onRemoved.addListener).mock.calls.at(-1)?.[0];
}

function onAdded(): ((permissions: { origins?: string[]; permissions?: string[] }) => void) | undefined {
  return vi.mocked(chrome.permissions.onAdded.addListener).mock.calls.at(-1)?.[0];
}

function sessionSet(): ReturnType<typeof vi.fn> {
  return chrome.storage.session.set as unknown as ReturnType<typeof vi.fn>;
}

function sessionGet(): ReturnType<typeof vi.fn> {
  return chrome.storage.session.get as unknown as ReturnType<typeof vi.fn>;
}

// vi.mocked infers a chrome API's last overload — the callback form — so the
// Promise signatures these tests mock are spelled out explicitly.
function permissionsGetAll() {
  return vi.mocked(chrome.permissions.getAll as () => Promise<chrome.permissions.Permissions>);
}

function registeredScripts() {
  return vi.mocked(chrome.scripting.getRegisteredContentScripts as (
    filter?: chrome.scripting.ContentScriptFilter,
  ) => Promise<chrome.scripting.RegisteredContentScript[]>);
}

// Assertions about persisted cache entries must ignore any other keys'
// writes to the shared session area.
function previewCacheWrites(): unknown[] {
  return sessionSet().mock.calls
    .map(([value]) => value)
    .filter(value => Boolean(value) && typeof value === 'object' && 'previewCache' in value);
}

function containsCallsFor(pattern: string): number {
  return vi.mocked(chrome.permissions.contains).mock.calls
    .filter(([permissions]) => permissions.origins?.includes(pattern)).length;
}

function tabRemoved(tabId: number): void {
  vi.mocked(chrome.tabs.onRemoved.addListener).mock.calls[0]?.[0]?.(tabId, { windowId: 1, isWindowClosing: false });
}

const tick = () => new Promise(resolve => { setTimeout(resolve, 0); });

beforeEach(async () => {
  vi.resetModules();
  vi.resetAllMocks();
  redirectListener = undefined;
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('chrome', {
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      getAll: vi.fn().mockResolvedValue({ origins: [] }),
      onAdded: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    scripting: {
      getRegisteredContentScripts: vi.fn().mockResolvedValue([]),
      registerContentScripts: vi.fn().mockResolvedValue(undefined),
      updateContentScripts: vi.fn().mockResolvedValue(undefined),
      unregisterContentScripts: vi.fn().mockResolvedValue(undefined),
    },
    runtime: {
      id: 'peeklink',
      onMessage: { addListener },
      getURL: (path: string) => `chrome-extension://peeklink/${path}`,
    },
    webRequest: {
      onHeadersReceived: {
        addListener: vi.fn((listener: (details: chrome.webRequest.WebResponseHeadersDetails) => void) => {
          redirectListener = listener;
        }),
        removeListener: vi.fn((listener: (details: chrome.webRequest.WebResponseHeadersDetails) => void) => {
          if (redirectListener === listener) redirectListener = undefined;
        }),
      },
    },
    tabs: { onRemoved: { addListener: vi.fn() } },
    action: { onClicked: { addListener: vi.fn() } },
    storage: {
      session: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
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

  it('follows a validated cross-host redirect and previews the final address', async () => {
    const input = `${origin}/`;
    const final = 'https://www.destination.example.com/';
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return redirectResponse();
      }
      return htmlResponse();
    });

    const result = await preview(input);
    expect(result).toMatchObject({
      ok: true,
      data: { title: 'TestFlight beta', url: final, hostname: 'destination.example.com' },
    });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([input, final]);
  });

  it('resolves a relative redirect location against the current address', async () => {
    const input = `${origin}/redirect`;
    const final = `${origin}/final`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, '/final');
        return redirectResponse();
      }
      return htmlResponse();
    });

    expect(await preview(input)).toMatchObject({ ok: true, data: { url: final } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([input, final]);
  });

  it('does not fetch a redirect target that has not been granted', async () => {
    const input = `${origin}/`;
    const final = 'https://redirected.example.com/';
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(!origins.includes('https://redirected.example.com/*')));
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) emitRedirect(href, final);
      return redirectResponse();
    });

    const result = await preview(input);
    expect(result).toMatchObject({ ok: false, code: 'permission' });
    expect(result.ok === false && result.error).toContain('redirected.example.com');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a redirect to a private network address before fetching it', async () => {
    const input = `${origin}/`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) emitRedirect(href, 'http://192.168.1.1/admin');
      return redirectResponse();
    });

    expect(await preview(input)).toMatchObject({ ok: false, code: 'blocked-host' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports an invalid redirect location without fetching it', async () => {
    const input = `${origin}/`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) emitRedirect(href, 'http://[::1');
      return redirectResponse();
    });

    const result = await preview(input);
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
    expect(result.ok === false && result.error).toContain('invalid address');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores redirect observations that did not come from the extension', async () => {
    const input = `${origin}/`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) emitRedirect(href, 'https://www.destination.example.com/', 'https://source.example.com');
      return redirectResponse();
    });

    expect(await preview(input)).toMatchObject({ ok: false, code: 'redirect' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('refetches a redirect target immediately after its permission is granted', async () => {
    const input = `${origin}/`;
    const final = 'https://redirected.example.com/';
    let targetGranted = false;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(!origins.includes('https://redirected.example.com/*') || targetGranted));
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return redirectResponse();
      }
      return htmlResponse();
    });

    expect(await preview(input, 71)).toMatchObject({ ok: false, code: 'permission' });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    targetGranted = true;
    expect(await preview(input, 72)).toMatchObject({ ok: true, data: { url: final } });
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([input, input, final]);
  });

  it('stops redirect loops', async () => {
    const first = `${origin}/loop-a`;
    const second = `${origin}/loop-b`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === first) emitRedirect(href, second);
      if (href === second) emitRedirect(href, first);
      return redirectResponse();
    });

    const result = await preview(first);
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
    expect(result.ok === false && result.error).toContain('loop');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([first, second]);
  });

  it('stops after the redirect limit', async () => {
    const start = `${origin}/r0`;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      const match = /^https:\/\/destination\.example\.com\/r(\d)$/.exec(href);
      if (match) emitRedirect(href, `${origin}/r${Number(match[1]) + 1}`);
      return redirectResponse();
    });

    const result = await preview(start);
    expect(result).toMatchObject({ ok: false, code: 'redirect' });
    expect(result.ok === false && result.error).toContain('too many times');
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('evicts a cached redirect preview when the final host grant is removed', async () => {
    const input = `${origin}/`;
    const final = 'https://www.destination.example.com/';
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return redirectResponse();
      }
      return htmlResponse();
    });

    expect(await preview(input)).toMatchObject({ ok: true });
    expect(await preview(input)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    onRemoved()?.({ origins: ['https://www.destination.example.com/*'], permissions: [] });

    expect(await preview(input)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('cancels an in-flight redirect target when its grant is removed', async () => {
    const input = `${origin}/`;
    const final = 'https://www.destination.example.com/';
    let finalSignal: AbortSignal | undefined;
    fetchMock.mockImplementation((inputUrl, init) => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return Promise.resolve(redirectResponse());
      }
      finalSignal = init?.signal ?? undefined;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const result = preview(input, 70);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    onRemoved()?.({ origins: ['https://www.destination.example.com/*'], permissions: [] });

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
    expect(finalSignal?.aborted).toBe(true);
  });

  it('does not let a stale in-flight grant resolve back into the cache after a revocation', async () => {
    const input = `${origin}/`;
    const final = 'https://www.destination.example.com/';
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return redirectResponse();
      }
      return htmlResponse();
    });
    const finalResolvers: Array<(granted: boolean) => void> = [];
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      origins.includes('https://www.destination.example.com/*')
        ? new Promise<boolean>(resolve => { finalResolvers.push(resolve); })
        : Promise.resolve(true));

    const result = preview(input, 90);
    await vi.waitFor(() => expect(finalResolvers).toHaveLength(1));
    onRemoved()?.({ origins: ['https://www.destination.example.com/*'], permissions: [] });
    // The query resolves granted only after the revocation invalidated it —
    // the stale answer must not be served to this waiter or cached for others.
    finalResolvers[0]?.(true);
    expect(await result).toMatchObject({ ok: false, code: 'permission' });

    const second = preview(input, 91);
    await vi.waitFor(() => expect(finalResolvers).toHaveLength(2));
    finalResolvers[1]?.(true);
    expect(await second).toMatchObject({ ok: true, data: { url: final } });
  });

  it('keeps a replacement flight tracked when a superseded flight finishes late', async () => {
    const input = `${origin}/`;
    const final = 'https://www.destination.example.com/';
    let finalPermissionCalls = 0;
    let releaseFirstPermission!: (granted: boolean) => void;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (origins.includes('https://www.destination.example.com/*')) {
        finalPermissionCalls += 1;
        if (finalPermissionCalls === 1) {
          return new Promise<boolean>(resolve => { releaseFirstPermission = resolve; });
        }
      }
      return Promise.resolve(true);
    });
    let finalSignal: AbortSignal | undefined;
    let releaseFinal: ((response: Response) => void) | undefined;
    fetchMock.mockImplementation((inputUrl, init) => {
      const href = String(inputUrl);
      if (href === input) {
        emitRedirect(href, final);
        return Promise.resolve(redirectResponse());
      }
      finalSignal = init?.signal ?? undefined;
      return new Promise<Response>((resolve, reject) => {
        releaseFinal = resolve;
        init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    });

    const first = preview(input, 91);
    await vi.waitFor(() => expect(finalPermissionCalls).toBe(1));
    cancel(91);
    expect(await first).toMatchObject({ ok: false, code: 'cancelled' });

    const second = preview(input, 92);
    // The replacement joins the first flight's in-flight grant query; release
    // it so both proceed, and let the superseded flight clean up late.
    releaseFirstPermission(true);
    await vi.waitFor(() => expect(releaseFinal).toBeDefined());
    await tick();
    await tick();
    onRemoved()?.({ origins: ['https://www.destination.example.com/*'], permissions: [] });

    const aborted = finalSignal?.aborted;
    releaseFinal?.(htmlResponse());
    expect(await second).toMatchObject({ ok: false, code: 'permission' });
    expect(aborted).toBe(true);
  });

  it('keeps concurrent redirect observations for a shared URL isolated', async () => {
    const firstInput = `${origin}/first`;
    const shared = 'https://shared.example.com/hop';
    const firstFinal = 'https://first-final.example.com/';
    const secondFinal = 'https://second-final.example.com/';
    let sharedCalls = 0;
    let releaseFirstShared!: (response: Response) => void;
    fetchMock.mockImplementation(async inputUrl => {
      const href = String(inputUrl);
      if (href === firstInput) {
        emitRedirect(href, shared);
        return redirectResponse();
      }
      if (href === shared) {
        sharedCalls += 1;
        if (sharedCalls === 1) {
          emitRedirect(shared, firstFinal);
          return new Promise<Response>(resolve => { releaseFirstShared = resolve; });
        }
        emitRedirect(shared, secondFinal);
        return redirectResponse();
      }
      return htmlResponse();
    });

    const first = preview(firstInput, 95);
    await vi.waitFor(() => expect(sharedCalls).toBe(1));
    const second = preview(shared, 96);
    await tick();
    await tick();
    releaseFirstShared(redirectResponse());

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ ok: true, data: { url: firstFinal } });
    expect(secondResult).toMatchObject({ ok: true, data: { url: secondFinal } });
  });

  it('releases global concurrency slots when URL-lock waiters are cancelled', async () => {
    const shared = 'https://shared.example.com/hop';
    const fresh = `${origin}/fresh`;
    let releaseOwner!: (response: Response) => void;
    let freshStarted = false;
    fetchMock.mockImplementation(async (inputUrl, init) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const href = String(inputUrl);
      if (href === shared) {
        return new Promise<Response>((resolve, reject) => {
          releaseOwner = resolve;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      if (href === fresh) {
        freshStarted = true;
        return htmlResponse();
      }
      emitRedirect(href, shared);
      return redirectResponse();
    });

    const owner = preview(shared, 1);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const waiters = [2, 3, 4].map(id => preview(`${origin}/r${id}`, id));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    // Let the waiters consume their redirects and queue on the shared URL lock.
    await tick();
    await tick();
    [2, 3, 4].forEach(cancel);
    expect(await Promise.all(waiters)).toEqual([
      expect.objectContaining({ ok: false, code: 'cancelled' }),
      expect.objectContaining({ ok: false, code: 'cancelled' }),
      expect.objectContaining({ ok: false, code: 'cancelled' }),
    ]);

    const unrelated = preview(fresh, 5);
    // The cancelled waiters must free their slots before the lock owner ends.
    await vi.waitFor(() => expect(freshStarted).toBe(true));
    releaseOwner(htmlResponse());
    await owner;
    expect(await unrelated).toMatchObject({ ok: true });
  });

  it('allows the next hover to recover immediately after a transient failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce(htmlResponse());
    const url = `${origin}/testflight`;
    expect(await preview(url)).toMatchObject({ ok: false, code: 'network' });
    expect(await preview(url)).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('removes the redirect observer when fetching settles', async () => {
    fetchMock.mockResolvedValueOnce(htmlResponse());
    expect(await preview(`${origin}/testflight`)).toMatchObject({ ok: true });
    expect(chrome.webRequest.onHeadersReceived.addListener).toHaveBeenCalledTimes(1);
    expect(chrome.webRequest.onHeadersReceived.removeListener).toHaveBeenCalledTimes(1);
  });

  it('applies a mid-flight revocation to shared waiters and skips the cache write', async () => {
    // Track pending fetches per URL: the global call count and positional
    // resolvers can be poisoned by a stray call from a stale module task,
    // which would leave `third` unresolved instead of failing fast.
    const pendingFetches: Array<{ href: string; resolve: (response: Response) => void }> = [];
    fetchMock.mockImplementation(input => new Promise<Response>(resolve => {
      pendingFetches.push({ href: String(input), resolve });
    }));
    const fetchesFor = (href: string) => pendingFetches.filter(call => call.href === href);
    let targetGranted = true;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(!origins.includes('https://destination.example.com/*') || targetGranted));

    const url = `${origin}/testflight`;
    const first = preview(url, 1);
    const second = preview(url, 2);
    await vi.waitFor(() => expect(fetchesFor(url)).toHaveLength(1));
    targetGranted = false;
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    fetchesFor(url)[0]?.resolve(htmlResponse());

    expect(await first).toMatchObject({ ok: false, code: 'permission' });
    expect(await second).toMatchObject({ ok: false, code: 'permission' });

    // Restoring access must refetch: the revoked flight never reached the cache.
    targetGranted = true;
    onAdded()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    const third = preview(url, 3);
    await vi.waitFor(() => expect(fetchesFor(url)).toHaveLength(2));
    fetchesFor(url)[1]?.resolve(htmlResponse());
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

  it('honors a cancel that lands between the fetch resolving and delivery', async () => {
    let releaseFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));

    const result = preview(`${origin}/testflight`, 41);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch(htmlResponse());
    cancel(41);

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
    let releaseFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));
    const resolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { resolvers.push(resolve); });
    });

    const result = preview(`${origin}/testflight`, 51);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // An unrelated revocation refreshes the grant cache, so the delivery
    // recheck re-queries the source grant instead of serving it from cache.
    onRemoved()?.({ origins: ['https://unrelated.example.com/*'], permissions: [] });
    releaseFetch(htmlResponse());
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    cancel(51);
    resolvers[0]?.(false);

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('denies a request whose source recheck resolves without the grant', async () => {
    let releaseFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));
    const resolvers: Array<(granted: boolean) => void> = [];
    let sourceCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://source.example.com/*')) return Promise.resolve(true);
      sourceCalls += 1;
      return sourceCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { resolvers.push(resolve); });
    });

    const result = preview(`${origin}/testflight`, 52);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    onRemoved()?.({ origins: ['https://unrelated.example.com/*'], permissions: [] });
    releaseFetch(htmlResponse());
    await vi.waitFor(() => expect(sourceCalls).toBe(2));
    resolvers[0]?.(false);

    expect(await result).toMatchObject({ ok: false, code: 'permission' });
  });

  it('denies delivery when the destination grant is removed during the final recheck', async () => {
    let releaseFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));
    const destResolvers: Array<(granted: boolean) => void> = [];
    let destCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://destination.example.com/*')) return Promise.resolve(true);
      destCalls += 1;
      return destCalls === 1 ? Promise.resolve(true) : new Promise<boolean>(resolve => { destResolvers.push(resolve); });
    });

    const result = preview(`${origin}/testflight`, 61);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // An unrelated revocation refreshes the grant cache so the recheck after
    // the fetch becomes a real query again.
    onRemoved()?.({ origins: ['https://unrelated.example.com/*'], permissions: [] });
    releaseFetch(htmlResponse());
    await vi.waitFor(() => expect(destCalls).toBe(2));
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    destResolvers[0]?.(true);

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
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));

    const result = preview(`${origin}/testflight`, 80);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    cancel(80);
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    for (let i = 0; i < 520; i++) cancel(10_000 + i);
    resolvers[0]?.(htmlResponse());

    expect(await result).toMatchObject({ ok: false, code: 'cancelled' });
  });

  it('keeps a revocation settlement over a later cancellation', async () => {
    const resolvers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { resolvers.push(resolve); }));

    const result = preview(`${origin}/testflight`, 81);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });
    cancel(81);
    resolvers[0]?.(htmlResponse());

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

  it('previews a huge page when its head closes within the byte cap', async () => {
    const head = '<title>Big page</title><meta property="og:description" content="heavy but fine"></head><body>';
    const html = head + 'x'.repeat(500_000);
    fetchMock.mockResolvedValueOnce(new Response(html, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/huge`)).toMatchObject({
      ok: true,
      data: { title: 'Big page', description: 'heavy but fine' },
    });
  });

  // The stream errors once it is pulled past the metadata-bearing chunks, so
  // these previews can only succeed if reading stops at the head end.
  function headThenErrorStream(parts: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < parts.length) {
          controller.enqueue(encoder.encode(parts[index]));
          index += 1;
        } else {
          controller.error(new Error('read past the head end'));
        }
      },
    });
  }

  it('stops reading the body once the head end is seen', async () => {
    const stream = headThenErrorStream(['<title>Early stop</title></head><body>']);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/early`)).toMatchObject({ ok: true, data: { title: 'Early stop' } });
  });

  it('detects a head end split across chunk boundaries', async () => {
    const stream = headThenErrorStream(['<title>Split</title></he', 'ad><body>']);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/split`)).toMatchObject({ ok: true, data: { title: 'Split' } });
  });

  it('handles a head end delivered one byte at a time', async () => {
    const parts = ['<title>Byte split</title>', ...'</head><body>'];
    let index = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < parts.length) controller.enqueue(new TextEncoder().encode(parts[index++]));
        else controller.error(new Error('read past the head end'));
      },
    });
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/byte-split`)).toMatchObject({ ok: true, data: { title: 'Byte split' } });
  });

  it('ignores marker-like text inside head scripts', async () => {
    const stream = headThenErrorStream([
      '<head><script>const template = "<body class=example>";</script>',
      '<title>Actual title</title><meta name="description" content="Actual description"></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/script-marker`)).toMatchObject({
      ok: true, data: { title: 'Actual title', description: 'Actual description' },
    });
  });

  it('ignores marker-like text inside head comments and attributes', async () => {
    const stream = headThenErrorStream([
      '<head><!-- <body> </head> --><meta content="</head><body>" name="x">',
      '<title>Comment test</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/comment-marker`)).toMatchObject({ ok: true, data: { title: 'Comment test' } });
  });

  it('does not treat longer tag names with a head or body prefix as the head end', async () => {
    const stream = headThenErrorStream([
      '<title>Long names</title><bodyxyz>',
      '<meta name="description" content="still head"></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/long-names`)).toMatchObject({
      ok: true, data: { title: 'Long names', description: 'still head' },
    });
  });

  it('keeps reading double-escaped script contents until the real script end', async () => {
    const stream = headThenErrorStream([
      '<head><script><!--\n<script>\nconst first = "</script>";\nconst second = "<body>";\n//--></script>',
      '<title>Actual title</title><meta name="description" content="Actual description"></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/double-escaped-script`)).toMatchObject({
      ok: true, data: { title: 'Actual title', description: 'Actual description' },
    });
  });

  it('stops at the XHTML head end after a self-closing script', async () => {
    const stream = headThenErrorStream([
      '<html xmlns="http://www.w3.org/1999/xhtml"><head><script src="/app.js"/>',
      '<title>XHTML title</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/xhtml+xml' } }));

    expect(await preview(`${origin}/xhtml-script`)).toMatchObject({ ok: true, data: { title: 'XHTML title' } });
  });

  it('reconsumes a mismatching closing script candidate', async () => {
    const stream = headThenErrorStream([
      '<head><script><!--\nconst first="</s<script>";\nconst second="</script>";\nconst third="<body>";\n//--></script>',
      '<title>Actual title</title><meta name="description" content="Actual description"></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/reconsume`)).toMatchObject({
      ok: true, data: { title: 'Actual title', description: 'Actual description' },
    });
  });

  it('exits script escaped state on an immediately closing comment', async () => {
    const stream = headThenErrorStream([
      '<head><script><!-->\nconst template="<script>";</script>',
      '<title>Actual title</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/comment-exit`)).toMatchObject({ ok: true, data: { title: 'Actual title' } });
  });

  it.each([
    '<!--<-->\nconst template="<script>";',
    '<!--\nconst template="<script>";\nconst ending="<-->";',
  ])('reconsumes a dash directly after an escaped less-than sign', async code => {
    const stream = headThenErrorStream([
      `<head><script>${code}</script>`,
      '<title>Actual title</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/lt-dash`)).toMatchObject({ ok: true, data: { title: 'Actual title' } });
  });

  it('treats "<!-->" as an abruptly closed comment', async () => {
    const stream = headThenErrorStream([
      '<head><!--><script>var x = 1;</script>',
      '<title>After comment</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/abrupt-comment`)).toMatchObject({ ok: true, data: { title: 'After comment' } });
  });

  it('skips bogus comments as a unit', async () => {
    const stream = headThenErrorStream([
      '<head><!foo <body>',
      '<title>Bogus test</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/bogus-comment`)).toMatchObject({ ok: true, data: { title: 'Bogus test' } });
  });

  it('skips quoted attribute values inside end tags', async () => {
    const stream = headThenErrorStream([
      '<head><script>x</script data-x="> <body>">',
      '<title>End tag attrs</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/end-tag-attrs`)).toMatchObject({ ok: true, data: { title: 'End tag attrs' } });
  });

  it('closes comments at "--!>" like browsers do', async () => {
    const stream = headThenErrorStream([
      '<head><!--comment--!><script>x</script>',
      '<title>Bang close</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/bang-close`)).toMatchObject({ ok: true, data: { title: 'Bang close' } });
  });

  it.each([
    ['<head><script>x</script data-x=foo">', '"'],
    ["<head><script>x</script data-x=foo'>", "'"],
  ])('ignores quotes inside unquoted end-tag attribute values', async (prefix) => {
    const stream = headThenErrorStream([
      prefix,
      '<title>Unquoted attrs</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/unquoted-end-attrs`)).toMatchObject({ ok: true, data: { title: 'Unquoted attrs' } });
  });

  it('still skips properly quoted end-tag attribute values', async () => {
    const stream = headThenErrorStream([
      '<head><script>x</script data-x="> <body>">',
      '<title>End tag attrs</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/quoted-end-attrs`)).toMatchObject({ ok: true, data: { title: 'End tag attrs' } });
  });

  it.each([
    ['start tag', '<head><script ="foo>x</script>'],
    ['start tag single-quote variant', "<head><script ='foo>x</script>"],
    ['end tag', '<head><script>x</script ="foo>'],
    ['end tag single-quote variant', "<head><script>x</script ='foo>"],
  ])('treats a leading equals sign as part of a malformed %s attribute name', async (_kind, prefix) => {
    const suffix = '<title>Malformed attrs</title></head>';
    const chunkings = [[prefix, suffix], [...(prefix + suffix)]];
    for (const [index, parts] of chunkings.entries()) {
      const stream = headThenErrorStream(parts);
      fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'text/html' } }));

      expect(await preview(`${origin}/malformed-attrs-${index}`)).toMatchObject({ ok: true, data: { title: 'Malformed attrs' } });
    }
  });

  it('ignores marker-like text inside XHTML CDATA sections', async () => {
    const stream = headThenErrorStream([
      '<head><script><![CDATA[</head><body>]]></script>',
      '<title>Cdata test</title></head>',
    ]);
    fetchMock.mockResolvedValueOnce(new Response(stream, { headers: { 'content-type': 'application/xhtml+xml' } }));

    expect(await preview(`${origin}/cdata-marker`)).toMatchObject({ ok: true, data: { title: 'Cdata test' } });
  });

  it('truncates at the byte cap and keeps metadata when the head never closes', async () => {
    const head = '<title>Cap test</title><!--' + 'x'.repeat(500_000);
    fetchMock.mockResolvedValueOnce(new Response(head, { headers: { 'content-type': 'text/html' } }));

    expect(await preview(`${origin}/never-closes`)).toMatchObject({ ok: true, data: { title: 'Cap test' } });
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

  it('prefetches ahead of the popup and serves the later preview without refetching', async () => {
    fetchMock.mockResolvedValue(htmlResponse());
    expect(await prefetch(`${origin}/`, 11)).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(await preview(`${origin}/`, 12)).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('joins an in-flight prefetch instead of starting a second fetch', async () => {
    let resolveFetch!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>(resolve => { resolveFetch = resolve; }));
    const prefetching = prefetch(`${origin}/`, 21);
    await tick();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const previewing = preview(`${origin}/`, 22);
    resolveFetch(htmlResponse());
    expect(await prefetching).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(await previewing).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('mirrors the cache to session storage and restores it after a worker restart', async () => {
    fetchMock.mockResolvedValue(htmlResponse());
    expect(await preview(`${origin}/`, 1)).toMatchObject({ ok: true });
    await tick();

    const snapshot = previewCacheWrites().at(-1) as Record<string, unknown> | undefined;
    expect(snapshot?.['previewCache']).toHaveProperty(`${origin}/`);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Simulate a cold service worker start with only session storage surviving.
    vi.resetModules();
    sessionGet().mockResolvedValue(snapshot);
    const { default: restarted } = await import('../entrypoints/background');
    restarted.main();

    expect(await preview(`${origin}/`, 2)).toMatchObject({ ok: true, data: { title: 'TestFlight beta' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('drops revoked origins from the persisted cache snapshot', async () => {
    fetchMock.mockResolvedValue(htmlResponse());
    expect(await preview(`${origin}/`, 1)).toMatchObject({ ok: true });
    onRemoved()?.({ origins: ['https://*.destination.example.com/*'] });
    await tick();
    expect(previewCacheWrites().at(-1)).toEqual({ previewCache: {} });
  });

  it('does not start a fetch when the request is cancelled during cache restore', async () => {
    vi.resetModules();
    let resolveGet!: (value: Record<string, unknown>) => void;
    sessionGet().mockReturnValue(new Promise(resolve => { resolveGet = resolve; }));
    const { default: restarted } = await import('../entrypoints/background');
    restarted.main();

    const request = preview(`${origin}/`, 5);
    // Let the source and destination permission checks finish so startLoad is
    // blocked on the session restore before cancellation arrives.
    await tick();
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(2);
    cancel(5);
    // The cancel resolves promptly even though the restore read is pending.
    expect(await request).toMatchObject({ ok: false, code: 'cancelled' });
    resolveGet({});
    await tick();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies revocations that arrive while the session cache is restoring', async () => {
    fetchMock.mockImplementation(async () => htmlResponse());
    expect(await preview(`${origin}/`, 1)).toMatchObject({ ok: true });
    await tick();
    const snapshot = previewCacheWrites().at(-1) as Record<string, unknown> | undefined;
    expect(snapshot?.['previewCache']).toHaveProperty(`${origin}/`);

    // Simulate a cold start whose snapshot read is still pending when the
    // revocation event fires against the not-yet-restored cache.
    vi.resetModules();
    let resolveGet!: (value: unknown) => void;
    sessionGet().mockReturnValue(new Promise(resolve => { resolveGet = resolve; }));
    const { default: restarted } = await import('../entrypoints/background');
    restarted.main();
    onRemoved()?.({ origins: ['https://*.destination.example.com/*'] });
    resolveGet(snapshot);
    await tick();

    // The revoked entry must be pruned from the restored cache and re-persisted.
    expect(previewCacheWrites().at(-1)).toEqual({ previewCache: {} });
    expect(await preview(`${origin}/`, 2)).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe('origin grant cache', () => {
  it('shares one contains call between concurrent same-origin checks', async () => {
    let releaseFetch!: (response: Response) => void;
    fetchMock.mockImplementation(() => new Promise<Response>(resolve => { releaseFetch = resolve; }));

    const url = `${origin}/testflight`;
    const first = preview(url, 1);
    const second = preview(url, 2);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFetch(htmlResponse());

    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    // Admission, post-fetch, and delivery checks all share the one grant query.
    expect(containsCallsFor('https://destination.example.com/*')).toBe(1);
    expect(containsCallsFor('https://source.example.com/*')).toBe(1);
  });

  it('reuses resolved grants across previews until a permission event', async () => {
    fetchMock.mockResolvedValue(htmlResponse());
    const url = `${origin}/testflight`;
    expect(await preview(url, 1)).toMatchObject({ ok: true });
    const calls = vi.mocked(chrome.permissions.contains).mock.calls.length;

    expect(await preview(url, 2)).toMatchObject({ ok: true });
    expect(chrome.permissions.contains).toHaveBeenCalledTimes(calls);

    onRemoved()?.({ origins: ['https://unrelated.example.com/*'], permissions: [] });
    expect(await preview(url, 3)).toMatchObject({ ok: true });
    expect(vi.mocked(chrome.permissions.contains).mock.calls.length).toBeGreaterThan(calls);
  });

  it('re-queries grants once a permission event invalidates them', async () => {
    const granted = new Set(['https://source.example.com/*', 'https://destination.example.com/*']);
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(origins.every(o => granted.has(o))));
    fetchMock.mockResolvedValue(htmlResponse());
    const url = `${origin}/testflight`;
    expect(await preview(url, 1)).toMatchObject({ ok: true });
    const calls = vi.mocked(chrome.permissions.contains).mock.calls.length;

    granted.delete('https://destination.example.com/*');
    onRemoved()?.({ origins: ['https://destination.example.com/*'], permissions: [] });

    const result = preview(url, 2);
    await vi.waitFor(() => expect(vi.mocked(chrome.permissions.contains).mock.calls.length).toBeGreaterThan(calls));
    expect(await result).toMatchObject({ ok: false, code: 'permission' });
  });

  it('does not cache denials across calls', async () => {
    const granted = new Set(['https://source.example.com/*']);
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) =>
      Promise.resolve(origins.every(o => granted.has(o))));
    const url = `${origin}/testflight`;
    expect(await preview(url, 1)).toMatchObject({ ok: false, code: 'permission' });
    const calls = vi.mocked(chrome.permissions.contains).mock.calls.length;

    // Even without a grant event a later call must ask again — a stale denial
    // can never outlive a freshly granted origin.
    granted.add('https://destination.example.com/*');
    fetchMock.mockResolvedValue(htmlResponse());
    const second = preview(url, 2);
    await vi.waitFor(() => expect(vi.mocked(chrome.permissions.contains).mock.calls.length).toBeGreaterThan(calls));
    expect(await second).toMatchObject({ ok: true });
  });

  it('does not cache a transient permission IPC failure', async () => {
    let destCalls = 0;
    vi.mocked(chrome.permissions.contains).mockImplementation(({ origins = [] }) => {
      if (!origins.includes('https://destination.example.com/*')) return Promise.resolve(true);
      destCalls += 1;
      return destCalls === 1 ? Promise.reject(new Error('IPC dropped')) : Promise.resolve(true);
    });
    fetchMock.mockResolvedValue(htmlResponse());
    const url = `${origin}/testflight`;

    expect(await preview(url, 1)).toMatchObject({ ok: false, code: 'permission' });
    expect(await preview(url, 2)).toMatchObject({ ok: true });
  });
});

describe('content script registration', () => {
  const REGISTER_KEY = 'registrationSnapshot';
  const ORIGIN_A = 'https://a.example.com/*';
  const ORIGIN_B = 'https://b.example.com/*';

  function liveScript(matches: string[]): chrome.scripting.RegisteredContentScript {
    return {
      id: 'peeklink-preview',
      js: ['preview.js'],
      matches,
      runAt: 'document_idle',
      persistAcrossSessions: true,
    };
  }

  async function restartWithSession(get: (key: string) => Promise<Record<string, unknown>>): Promise<void> {
    // Let the startup sync that main() already scheduled finish so its work
    // cannot interleave with the restarted worker's.
    await tick();
    vi.resetModules();
    sessionGet().mockImplementation(get);
    vi.mocked(chrome.scripting.getRegisteredContentScripts).mockClear();
    vi.mocked(chrome.scripting.registerContentScripts).mockClear();
    vi.mocked(chrome.scripting.updateContentScripts).mockClear();
    vi.mocked(chrome.scripting.unregisterContentScripts).mockClear();
    const { default: restarted } = await import('../entrypoints/background');
    restarted.main();
    await tick();
    await tick();
  }

  it('skips the mutating IPCs when the live registration already matches the origins', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [ORIGIN_A] });
    registeredScripts().mockResolvedValue([liveScript([ORIGIN_A])]);
    await restartWithSession(() => Promise.resolve({}));
    expect(chrome.scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.updateContentScripts).not.toHaveBeenCalled();
    expect(chrome.scripting.unregisterContentScripts).not.toHaveBeenCalled();
  });

  it('registers the content script for the granted origins', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [ORIGIN_A] });
    await restartWithSession(() => Promise.resolve({}));
    expect(chrome.scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(1);
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'peeklink-preview', matches: [ORIGIN_A] })]);
    // Registration no longer leaves snapshot markers in session storage.
    const markerWrites = sessionSet().mock.calls
      .map(([value]) => value as Record<string, unknown>)
      .filter(value => REGISTER_KEY in value);
    expect(markerWrites).toEqual([]);
  });

  it('queries the live registration instead of trusting a stored fingerprint', async () => {
    // A stored "completed" fingerprint once meant "skip every scripting IPC";
    // a matching one must never suppress the live-state query again.
    await restartWithSession(key => Promise.resolve(
      key === REGISTER_KEY ? { [REGISTER_KEY]: '[]' } : {}));
    expect(chrome.scripting.getRegisteredContentScripts).toHaveBeenCalled();
  });

  it('registers on a cold start that finds a stale complete fingerprint', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [ORIGIN_A] });
    registeredScripts().mockResolvedValue([]);
    await restartWithSession(key => Promise.resolve(
      key === REGISTER_KEY ? { [REGISTER_KEY]: JSON.stringify([ORIGIN_A]) } : {}));
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'peeklink-preview', matches: [ORIGIN_A] })]);
  });

  it('re-registers a re-granted origin whose completed fingerprint went stale', async () => {
    let origins = [ORIGIN_A];
    let live: chrome.scripting.RegisteredContentScript[] = [liveScript([ORIGIN_A])];
    permissionsGetAll().mockImplementation(() => Promise.resolve({ origins }));
    registeredScripts().mockImplementation(() => Promise.resolve(live));
    vi.mocked(chrome.scripting.registerContentScripts).mockImplementation(scripts => {
      live = scripts;
      return Promise.resolve();
    });
    vi.mocked(chrome.scripting.updateContentScripts).mockImplementation(scripts => {
      live = scripts;
      return Promise.resolve();
    });
    vi.mocked(chrome.scripting.unregisterContentScripts).mockImplementation(() => {
      live = [];
      return Promise.resolve();
    });
    // The complete fingerprint written when A was first synced outlives every
    // later write — the outage that used to strand it.
    sessionGet().mockImplementation(key => Promise.resolve(
      key === REGISTER_KEY ? { [REGISTER_KEY]: JSON.stringify([ORIGIN_A]) } : {}));
    sessionSet().mockRejectedValue(new Error('storage gone'));

    // The revoke's unregister succeeds even though the snapshot cannot be
    // rewritten — storage now disagrees with the real registration.
    origins = [];
    onRemoved()?.({ origins: [ORIGIN_A], permissions: [] });
    await tick();
    await tick();
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['peeklink-preview'] });
    expect(live).toEqual([]);

    // Storage recovers with the stale "complete" marker intact; the regrant
    // must consult the live registration, find nothing, and register A.
    sessionSet().mockResolvedValue(undefined);
    origins = [ORIGIN_A];
    onAdded()?.({ origins: [ORIGIN_A], permissions: [] });
    await tick();
    await tick();
    expect(chrome.scripting.registerContentScripts).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'peeklink-preview', matches: [ORIGIN_A] })]);
  });

  it('unregisters a script whose origins were revoked despite a stale snapshot', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [] });
    registeredScripts().mockResolvedValue([liveScript([ORIGIN_A])]);
    await restartWithSession(key => Promise.resolve(
      key === REGISTER_KEY ? { [REGISTER_KEY]: JSON.stringify([ORIGIN_A]) } : {}));
    expect(chrome.scripting.unregisterContentScripts).toHaveBeenCalledWith({ ids: ['peeklink-preview'] });
  });

  it('updates a live registration whose matches no longer equal the origins', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [ORIGIN_A, ORIGIN_B] });
    registeredScripts().mockResolvedValue([liveScript([ORIGIN_A])]);
    await restartWithSession(() => Promise.resolve({}));
    expect(chrome.scripting.updateContentScripts).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'peeklink-preview', matches: [ORIGIN_A, ORIGIN_B] })]);
    expect(chrome.scripting.registerContentScripts).not.toHaveBeenCalled();
  });

  it('updates a live registration whose options differ from the desired script', async () => {
    permissionsGetAll().mockResolvedValue({ origins: [ORIGIN_A] });
    registeredScripts().mockResolvedValue([{ ...liveScript([ORIGIN_A]), allFrames: true }]);
    await restartWithSession(() => Promise.resolve({}));
    expect(chrome.scripting.updateContentScripts).toHaveBeenCalled();
  });

  it('still reconciles the registration when session storage fails', async () => {
    await restartWithSession(() => Promise.reject(new Error('storage gone')));
    expect(chrome.scripting.getRegisteredContentScripts).toHaveBeenCalled();
  });
});
