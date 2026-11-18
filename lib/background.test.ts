import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewResponse } from './types';

vi.mock('#imports', () => ({ defineBackground: (main: () => void) => ({ main }) }));

type Listener = (
  message: { type: string; url: string },
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

function preview(url: string): Promise<PreviewResponse> {
  const listener = addListener.mock.calls[0]?.[0];
  if (!listener) throw new Error('Missing preview message listener');
  return new Promise(resolve => {
    listener({ type: 'PEEKLINK_PREVIEW', url }, { id: 'peeklink', tab: { id: 1, url: 'https://source.example.com' } }, resolve);
  });
}

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
});
