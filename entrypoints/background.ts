import { defineBackground } from '#imports';
import { parseMetadata } from '../lib/metadata';
import { getFramePolicy } from '../lib/frame-policy';
import { urlOriginPattern } from '../lib/permissions';
import type { FramePolicy, PreviewErrorCode, PreviewResponse } from '../lib/types';

const SUCCESS_TTL = 15 * 60 * 1000;
const FAILURE_TTL = 30 * 1000;
const MAX_CACHE_ENTRIES = 250;
const MAX_HTML_BYTES = 400_000;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_QUEUED_REQUESTS = 32;
const REQUEST_TIMEOUT = 8_000;

const transientFailures = new Set<PreviewErrorCode>(['network', 'timeout', 'queue-full']);

class PreviewFailure extends Error {
  constructor(readonly code: PreviewErrorCode, message: string) {
    super(message);
  }
}

class RequestQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  run<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (this.waiting.length >= MAX_QUEUED_REQUESTS) {
        reject(new PreviewFailure('queue-full', 'Too many previews are waiting. Try again shortly.'));
        return;
      }

      const execute = async () => {
        this.active++;
        try {
          resolve(await task());
        } catch (error) {
          reject(error);
        } finally {
          this.active--;
          this.waiting.shift()?.();
        }
      };

      if (this.active < MAX_CONCURRENT_REQUESTS) void execute();
      else this.waiting.push(() => { void execute(); });
    });
  }
}

const queue = new RequestQueue();
const cache = new Map<string, { response: PreviewResponse; expires: number }>();
const pending = new Map<string, Promise<PreviewResponse>>();
const CONTENT_SCRIPT_ID = 'peeklink-preview';
let registrationSync: Promise<void> = Promise.resolve();

async function syncPreviewRegistration(): Promise<void> {
  const permissions = await chrome.permissions.getAll();
  const origins = permissions.origins ?? [];
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] });

  if (origins.length === 0) {
    if (registered.length > 0) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return;
  }

  const script = {
    id: CONTENT_SCRIPT_ID,
    js: ['preview.js'],
    matches: origins,
    runAt: 'document_idle' as const,
    persistAcrossSessions: true,
  };
  if (registered.length > 0) await chrome.scripting.updateContentScripts([script]);
  else await chrome.scripting.registerContentScripts([script]);
}

function schedulePreviewRegistration(): void {
  registrationSync = registrationSync.then(syncPreviewRegistration).catch(error => {
    console.error('Could not synchronize PeekLink content script registration.', error);
  });
}

function isPublicIPv4(hostname: string): boolean {
  const parts = hostname.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0, c = 0] = parts;

  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

function isPublicIPv6(hostname: string): boolean {
  const address = hostname.slice(1, -1).toLowerCase();
  if (!address || address.startsWith('::ffff:')) return false;
  if (address === '::' || address === '::1') return false;
  if (/^(?:fc|fd|fe[89ab]|ff)/.test(address)) return false;
  if (/^2001:(?:0:|db8:|10:)/.test(address)) return false;
  // Conservatively allow global-unicast space only (2000::/3).
  return /^[23]/.test(address);
}

function assertPublicUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new PreviewFailure('invalid-url', 'This link has an invalid URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new PreviewFailure('invalid-url', 'Only public HTTP and HTTPS links without credentials are supported.');
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isIPv4 = /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
  const isIPv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const blockedHostname = !isIPv4 && !isIPv6 && (!hostname.includes('.')
    || /(?:^|\.)(?:localhost|local|internal|intranet|private|home|lan|corp|test|invalid|example)$/.test(hostname));

  if (blockedHostname || (isIPv4 && !isPublicIPv4(hostname)) || (isIPv6 && !isPublicIPv6(hostname))) {
    throw new PreviewFailure('blocked-host', 'Previews are unavailable for local or private network addresses.');
  }

  url.hash = '';
  return url;
}

async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new PreviewFailure('too-large', 'This page is too large to preview safely.');
  }
  if (!response.body) throw new PreviewFailure('network', 'The website returned an empty response.');

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new PreviewFailure('too-large', 'This page is too large to preview safely.');
      }
      chunks.push(value);
    }
  } catch (error) {
    if (!(error instanceof PreviewFailure)) await reader.cancel().catch(() => undefined);
    throw error;
  }

  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function fetchHtml(url: URL): Promise<{ html: string; finalUrl: string; frame: FramePolicy }> {
  return queue.run(async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    try {
      const request = (target: URL) => fetch(target.href, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'manual',
        cache: 'no-store',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      let target = url;
      let response = await request(target);
      if (response.type === 'opaqueredirect' && url.pathname !== '/') {
        // Fetch hides the Location header. Probe only the same path's slash variant.
        target = new URL(url.href);
        target.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : `${url.pathname}/`;
        response = await request(target);
      }
      if (response.type === 'opaqueredirect' || (target !== url && !response.ok)) {
        await response.body?.cancel().catch(() => undefined);
        throw new PreviewFailure('redirect', 'This link redirects to another address. Open it in a new tab.');
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new PreviewFailure('http', `The website returned HTTP ${response.status}.`);
      }
      const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
      if (!contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) {
        await response.body?.cancel().catch(() => undefined);
        throw new PreviewFailure('not-html', 'This link does not point to an HTML page.');
      }
      const finalUrl = assertPublicUrl(response.url || target.href);
      const bytes = await readBoundedBytes(response, MAX_HTML_BYTES);
      return { html: new TextDecoder().decode(bytes), finalUrl: finalUrl.href, frame: getFramePolicy(response.headers) };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PreviewFailure('timeout', 'The preview request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function failureResponse(error: unknown): PreviewResponse {
  if (error instanceof PreviewFailure) return { ok: false, code: error.code, error: error.message };
  return {
    ok: false,
    code: 'network',
    error: 'Could not load this preview. The website may be unreachable or may block preview requests.',
  };
}

function readCache(key: string): PreviewResponse | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.response;
}

function writeCache(key: string, response: PreviewResponse): void {
  cache.delete(key);
  cache.set(key, { response, expires: Date.now() + (response.ok ? SUCCESS_TTL : FAILURE_TTL) });
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expires <= now) cache.delete(entryKey);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
}

async function loadPreview(url: URL): Promise<PreviewResponse> {
  const hasPermission = await chrome.permissions.contains({ origins: [urlOriginPattern(url)] });
  if (!hasPermission) {
    return {
      ok: false,
      code: 'permission',
      error: 'Website access is not granted. Allow this origin in PeekLink settings first.',
    };
  }

  const cached = readCache(url.href);
  if (cached) return cached;

  try {
    const { html, finalUrl, frame } = await fetchHtml(url);
    const response: PreviewResponse = { ok: true, data: parseMetadata(html, finalUrl), frame };
    writeCache(url.href, response);
    return response;
  } catch (error) {
    const response = failureResponse(error);
    if (!response.ok && !transientFailures.has(response.code)) writeCache(url.href, response);
    return response;
  }
}

function getPreview(rawUrl: string): Promise<PreviewResponse> {
  let url: URL;
  try {
    url = assertPublicUrl(rawUrl);
  } catch (error) {
    return Promise.resolve(failureResponse(error));
  }

  const existing = pending.get(url.href);
  if (existing) return existing;

  const request = loadPreview(url).catch(failureResponse).finally(() => pending.delete(url.href));
  pending.set(url.href, request);
  return request;
}

async function hasWebsitePermission(rawUrl: string | undefined): Promise<boolean> {
  if (!rawUrl) return false;
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    return chrome.permissions.contains({ origins: [urlOriginPattern(url)] });
  } catch {
    return false;
  }
}

async function handlePreviewRequest(url: string, sourceUrl: string | undefined): Promise<PreviewResponse> {
  if (!await hasWebsitePermission(sourceUrl)) {
    return {
      ok: false,
      code: 'permission',
      error: 'Access to the page containing this link has been removed or was not granted.',
    };
  }
  return getPreview(url);
}

export default defineBackground(() => {
  schedulePreviewRegistration();
  chrome.permissions.onAdded.addListener(schedulePreviewRegistration);
  chrome.permissions.onRemoved.addListener(schedulePreviewRegistration);

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: PreviewResponse) => void) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'PEEKLINK_PREVIEW') return false;
    if (sender.id !== chrome.runtime.id || !sender.tab?.id) return false;
    const url = 'url' in message ? message.url : undefined;
    if (typeof url !== 'string') return false;
    void handlePreviewRequest(url, sender.tab?.url ?? sender.url).catch(failureResponse).then(sendResponse);
    return true;
  });

  chrome.action.onClicked.addListener(() => {
    void chrome.runtime.openOptionsPage();
  });
});
