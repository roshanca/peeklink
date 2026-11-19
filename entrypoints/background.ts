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
const QUEUE_WAIT_TIMEOUT = 15_000;

const transientFailures = new Set<PreviewErrorCode>(['network', 'timeout', 'queue-full', 'cancelled']);

class PreviewFailure extends Error {
  constructor(readonly code: PreviewErrorCode, message: string) {
    super(message);
  }
}

interface QueueEntry {
  start: () => void;
  cancel: () => void;
}

class RequestQueue {
  private active = 0;
  private waiting: QueueEntry[] = [];

  private dequeue(entry: QueueEntry): boolean {
    const index = this.waiting.indexOf(entry);
    if (index < 0) return false;
    this.waiting.splice(index, 1);
    return true;
  }

  run<T>(task: (signal: AbortSignal) => Promise<T>): { promise: Promise<T>; cancel: () => void } {
    const controller = new AbortController();
    let onCancel: (() => void) | undefined;
    const promise = new Promise<T>((resolve, reject) => {
      const execute = async () => {
        if (controller.signal.aborted) {
          reject(new PreviewFailure('cancelled', 'The preview request was cancelled.'));
          this.waiting.shift()?.start();
          return;
        }
        this.active++;
        try {
          resolve(await task(controller.signal));
        } catch (error) {
          reject(error);
        } finally {
          this.active--;
          this.waiting.shift()?.start();
        }
      };

      if (this.active < MAX_CONCURRENT_REQUESTS) {
        void execute();
        return;
      }
      if (this.waiting.length >= MAX_QUEUED_REQUESTS) {
        reject(new PreviewFailure('queue-full', 'Too many previews are waiting. Try again shortly.'));
        return;
      }

      const entry: QueueEntry = { start: () => undefined, cancel: () => undefined };
      const deadline = setTimeout(() => {
        if (this.dequeue(entry)) {
          reject(new PreviewFailure('timeout', 'The preview request timed out while queued.'));
        }
      }, QUEUE_WAIT_TIMEOUT);
      entry.start = () => {
        clearTimeout(deadline);
        onCancel = undefined;
        void execute();
      };
      entry.cancel = () => {
        if (!this.dequeue(entry)) return;
        clearTimeout(deadline);
        reject(new PreviewFailure('cancelled', 'The preview request was cancelled.'));
      };
      this.waiting.push(entry);
      onCancel = entry.cancel;
    });
    return {
      promise,
      cancel: () => {
        controller.abort();
        onCancel?.();
      },
    };
  }
}

interface PendingPreview {
  promise: Promise<PreviewResponse>;
  waiters: Set<string>;
  cancel: () => void;
}

const queue = new RequestQueue();
const cache = new Map<string, { response: PreviewResponse; expires: number }>();
const pending = new Map<string, PendingPreview>();
let anonymousWaiter = 0;
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

function originMatchesPattern(url: URL, pattern: string): boolean {
  if (pattern === '<all_urls>') return true;
  const match = /^(\*|https?):\/\/([^/]+)/.exec(pattern);
  if (!match) return false;
  const [, scheme = '', authority = ''] = match;
  if (scheme !== '*' && url.protocol !== `${scheme}:`) return false;
  let wantedHost = authority;
  let wantedPort = '';
  if (authority.startsWith('[')) {
    const closing = authority.indexOf(']');
    if (closing !== -1) {
      wantedHost = authority.slice(0, closing + 1);
      if (authority[closing + 1] === ':') wantedPort = authority.slice(closing + 2);
    }
  } else {
    const portSep = authority.lastIndexOf(':');
    if (portSep !== -1) {
      wantedHost = authority.slice(0, portSep);
      wantedPort = authority.slice(portSep + 1);
    }
  }
  wantedHost = wantedHost.toLowerCase().replace(/\.$/, '');
  if (wantedPort && wantedPort !== (url.port || (url.protocol === 'https:' ? '443' : '80'))) return false;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (wantedHost === '*') return true;
  if (wantedHost.startsWith('*.')) {
    const domain = wantedHost.slice(2);
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === wantedHost;
}

function dropRevokedOrigins(patterns: string[]): void {
  if (patterns.length === 0) return;
  const revoked = (key: string) => {
    try {
      return patterns.some(pattern => originMatchesPattern(new URL(key), pattern));
    } catch {
      return false;
    }
  };
  for (const key of cache.keys()) {
    if (revoked(key)) cache.delete(key);
  }
  // Revoked grants settle matching waiters for the rest of the request
  // lifetime — a later regrant cannot revive them.
  for (const [waiterKey, source] of waiterSources) {
    if (revoked(source.href)) settleWaiter(waiterKey, 'source');
  }
  for (const [waiterKey, destination] of waiterDestinations) {
    if (revoked(destination.href)) settleWaiter(waiterKey, 'destination');
  }
  for (const [key, entry] of pending) {
    if (revoked(key)) {
      pending.delete(key);
      entry.cancel();
      continue;
    }
    for (const waiterKey of entry.waiters) {
      if (settledWaiters.has(waiterKey)) entry.waiters.delete(waiterKey);
    }
    if (entry.waiters.size === 0) {
      pending.delete(key);
      entry.cancel();
    }
  }
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

const ASCII_WS = /[ \t\n\f\r]/;
const trimAsciiWs = (value: string) => value.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');

// Collect MIME parameters with quoting resolved during the scan: `"` opens a
// quoted-string only as the very first character after `=` (apostrophes are
// token characters), `\` escapes the next character inside double quotes, an
// unclosed quoted-string collects to end of input, and junk after a closed
// quoted value is ignored through the next `;`.
function charsetParam(input: string): string | undefined {
  const params: Array<{ name: string; value: string; valid: boolean }> = [];
  let name = '';
  let val = '';
  let inValue = false;
  let expectValue = false;
  let quoted = false;
  let wasQuoted = false;
  let afterQuote = false;
  // A parameter is syntactically valid when it has `=` and its value bytes are
  // legal for its form: quoted values allow HTAB/0x20-0x7E/obs-text (qdtext and
  // quoted-pair results); unquoted values keep surrounding whitespace (the
  // encoding lookup trims it) but must otherwise be a non-empty HTTP token.
  const flush = () => {
    const valueOk = wasQuoted
      ? /^[\t\x20-\x7E\u0080-\uFFFF]*$/.test(val)
      : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(trimAsciiWs(val));
    params.push({ name, value: val, valid: inValue && valueOk });
  };
  for (let i = 0; i < input.length; i++) {
    const ch = input.charAt(i);
    if (quoted) {
      if (ch === '\\' && i + 1 < input.length) {
        val += input.charAt(i + 1);
        i++;
      } else if (ch === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        val += ch;
      }
      continue;
    }
    if (ch === ';') {
      flush();
      name = '';
      val = '';
      inValue = false;
      expectValue = false;
      wasQuoted = false;
      afterQuote = false;
      continue;
    }
    if (inValue) {
      if (afterQuote) continue;
      if (expectValue) {
        expectValue = false;
        if (ch === '"') {
          quoted = true;
          wasQuoted = true;
          continue;
        }
      }
      val += ch;
      continue;
    }
    if (ch === '=') {
      inValue = true;
      expectValue = true;
      continue;
    }
    name += ch;
  }
  flush();
  for (const { name: rawName, value: paramValue, valid } of params) {
    // Per mimesniff, only leading HTTP whitespace is skipped before a
    // parameter name — `charset ` (trailing space before `=`) is malformed.
    const paramName = rawName.replace(/^[ \t\n\r]+/, '');
    if (paramName.toLowerCase() !== 'charset' || !valid) continue;
    // The first syntactically valid charset parameter wins; an unusable value
    // falls through to document sniffing rather than to a later duplicate.
    const candidate = trimAsciiWs(paramValue);
    return candidate && /^[\w.:-]+$/.test(candidate) ? candidate : undefined;
  }
  return undefined;
}

// Yield attribute maps of <meta> tags. Comments consume through `-->` or the
// buffer end, quoting starts only at the beginning of an attribute value
// (`'`/`"` inside an unquoted value stay literal), and an unclosed quoted
// value consumes the rest of the buffer.
function* iterMetaTags(head: string): Generator<Record<string, string>> {
  for (let i = 0; i < head.length; i++) {
    if (head[i] !== '<') continue;
    if (head.startsWith('<!--', i)) {
      // The closing `--` may overlap the opening `<!--`, so `<!-->` is closed.
      const end = head.indexOf('-->', i + 2);
      i = end === -1 ? head.length : end + 2;
      continue;
    }
    const next = head.charAt(i + 1);
    if (next === '!' || next === '?') {
      const end = head.indexOf('>', i + 2);
      i = end === -1 ? head.length : end;
      continue;
    }
    const isEnd = next === '/';
    const name = /^[a-zA-Z][^\t\n\f\r />]*/.exec(head.slice(i + (isEnd ? 2 : 1)))?.[0];
    if (!name) {
      // `</` without a tag name is a bogus comment and runs to `>`.
      if (isEnd) {
        const end = head.indexOf('>', i + 2);
        i = end === -1 ? head.length : end;
      }
      continue;
    }
    let j = i + (isEnd ? 2 : 1) + name.length;
    const attrs: Record<string, string> = {};
    while (j < head.length && head[j] !== '>') {
      const attr = /^=?[^\t\n\f\r />=]*/.exec(head.slice(j))?.[0];
      if (!attr) { j++; continue; }
      const attrName = attr.toLowerCase();
      j += attr.length;
      while (j < head.length && ASCII_WS.test(head.charAt(j))) j++;
      if (head[j] !== '=') {
        attrs[attrName] ??= '';
        continue;
      }
      j++;
      while (j < head.length && ASCII_WS.test(head.charAt(j))) j++;
      const q = head[j];
      if (q === '"' || q === "'") {
        const close = head.indexOf(q, j + 1);
        if (close === -1) {
          attrs[attrName] ??= head.slice(j + 1);
          j = head.length;
          break;
        }
        attrs[attrName] ??= head.slice(j + 1, close);
        j = close + 1;
      } else {
        const raw = /^[^\t\n\f\r >]*/.exec(head.slice(j))?.[0] ?? '';
        attrs[attrName] ??= raw;
        j += raw.length;
      }
    }
    if (j >= head.length) return;
    i = j;
    if (!isEnd && name.toLowerCase() === 'meta') yield attrs;
  }
}

function supportedCharset(label: string | undefined): string | undefined {
  if (!label) return undefined;
  try {
    new TextDecoder(label);
    return label;
  } catch {
    return undefined;
  }
}

// HTML prescan remappings for meta declarations: resolve the label to its
// canonical decoder first, then treat UTF-16 family results as UTF-8 and
// `x-user-defined` as windows-1252. Unresolvable labels yield no declaration.
function metaEncoding(label: string | undefined): string | undefined {
  const normalized = label === undefined ? undefined : trimAsciiWs(label).toLowerCase();
  if (!normalized) return undefined;
  if (normalized === 'x-user-defined') return 'windows-1252';
  try {
    const encoding = new TextDecoder(normalized).encoding;
    return encoding === 'utf-16le' || encoding === 'utf-16be' ? 'utf-8' : encoding;
  } catch {
    return undefined;
  }
}

// Read the `encoding` pseudo-attribute of an XML declaration body (the text
// between `<?xml` and `?>`). Matches only at a pseudo-attribute boundary
// outside quoted values, per the case-sensitive XML grammar.
function xmlDeclEncoding(decl: string): string | undefined {
  for (let p = 0; p < decl.length; p++) {
    const ch = decl.charAt(p);
    if (ch === '"' || ch === "'") {
      const close = decl.indexOf(ch, p + 1);
      if (close === -1) return undefined;
      p = close;
      continue;
    }
    if ((p === 0 || ASCII_WS.test(decl.charAt(p - 1))) && decl.startsWith('encoding', p)) {
      let q = p + 'encoding'.length;
      while (q < decl.length && ASCII_WS.test(decl.charAt(q))) q++;
      if (decl.charAt(q) !== '=') continue;
      q++;
      while (q < decl.length && ASCII_WS.test(decl.charAt(q))) q++;
      const quote = decl.charAt(q);
      if (quote !== '"' && quote !== "'") return undefined;
      const close = decl.indexOf(quote, q + 1);
      return close === -1 ? undefined : decl.slice(q + 1, close);
    }
  }
  return undefined;
}

// The "extracting character encodings from meta elements" algorithm: the
// charset value inside a `content` attribute may be single-quoted,
// double-quoted, or unquoted.
function extractMetaCharset(content: string): string | undefined {
  const lower = content.toLowerCase();
  let pos = lower.indexOf('charset');
  while (pos !== -1) {
    pos += 'charset'.length;
    while (pos < content.length && ASCII_WS.test(content.charAt(pos))) pos++;
    if (content[pos] !== '=') {
      pos = lower.indexOf('charset', pos);
      continue;
    }
    pos++;
    while (pos < content.length && ASCII_WS.test(content.charAt(pos))) pos++;
    const q = content[pos];
    if (q === '"' || q === "'") {
      const close = content.indexOf(q, pos + 1);
      return close === -1 ? undefined : content.slice(pos + 1, close);
    }
    const rest = content.slice(pos);
    const end = rest.search(/[;\t\n\f\r ]/);
    return (end === -1 ? rest : rest.slice(0, end)) || undefined;
  }
  return undefined;
}

function sniffCharset(contentType: string, bytes: Uint8Array): string {
  if (bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) return 'utf-8';
  if (bytes[0] === 0xFF && bytes[1] === 0xFE) return 'utf-16le';
  if (bytes[0] === 0xFE && bytes[1] === 0xFF) return 'utf-16be';
  const fromHeader = supportedCharset(charsetParam(contentType));
  if (fromHeader) return fromHeader;
  const mime = contentType.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096));
  if (mime.endsWith('/xml') || mime.endsWith('+xml')) {
    // XML documents use the encoding pseudo-attribute of the XML declaration
    // instead of HTML meta sniffing. Without a BOM, `00 3C`/`3C 00` prefixes
    // still betray a UTF-16 byte order per XML autodetection.
    const utf16 = bytes[0] === 0x00 && bytes[1] === 0x3C ? 'utf-16be'
      : bytes[0] === 0x3C && bytes[1] === 0x00 ? 'utf-16le' : undefined;
    const probe = utf16 ? new TextDecoder(utf16).decode(bytes.subarray(0, 4096)) : head;
    if (probe.startsWith('<?xml') && ASCII_WS.test(probe.charAt(5))) {
      const end = probe.indexOf('?>', 5);
      if (end !== -1) {
        const declared = supportedCharset(xmlDeclEncoding(probe.slice(5, end)));
        if (declared) {
          // A generic UTF-16 declaration keeps the byte order detected from
          // the leading bytes instead of defaulting to little-endian.
          const encoding = new TextDecoder(declared).encoding;
          if (utf16 && (encoding === 'utf-16le' || encoding === 'utf-16be')) return utf16;
          return declared;
        }
      }
    }
    return utf16 ?? 'utf-8';
  }
  for (const meta of iterMetaTags(head)) {
    if ('charset' in meta) {
      // A present charset attribute shadows http-equiv content on the same
      // tag, even when its label cannot be resolved.
      const declared = metaEncoding(meta.charset);
      if (declared) return declared;
      continue;
    }
    if ((meta['http-equiv'] ?? '').toLowerCase() === 'content-type') {
      const declared = metaEncoding(extractMetaCharset(meta.content ?? ''));
      if (declared) return declared;
    }
  }
  return 'utf-8';
}

function decodeHtml(bytes: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(sniffCharset(contentType, bytes)).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function fetchHtml(url: URL): { promise: Promise<{ html: string; finalUrl: string; frame: FramePolicy }>; cancel: () => void } {
  return queue.run(async signal => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const propagate = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', propagate, { once: true });
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
      return { html: decodeHtml(bytes, contentType), finalUrl: finalUrl.href, frame: getFramePolicy(response.headers) };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw signal.aborted
          ? new PreviewFailure('cancelled', 'The preview request was cancelled.')
          : new PreviewFailure('timeout', 'The preview request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', propagate);
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

const PERMISSION_DENIED: PreviewResponse = {
  ok: false,
  code: 'permission',
  error: 'Website access is not granted. Allow this origin in PeekLink settings first.',
};

const CANCELLED: PreviewResponse = {
  ok: false,
  code: 'cancelled',
  error: 'The preview request was cancelled.',
};

// Waiter lifecycle state: a settled waiter (cancelled or grant-revoked) stays
// settled until its request ends, so a later regrant cannot revive it. The
// first terminal event wins — a revocation cannot mask an explicit cancel.
const waiterSources = new Map<string, URL>();
const waiterDestinations = new Map<string, URL>();
const settledWaiters = new Map<string, 'cancelled' | 'source' | 'destination'>();
const liveWaiterKeys = new Set<string>();
// Resolves a waiter's settledSignal so it stops blocking on the shared
// entry.promise while other waiters' fetch is still running.
const waiterNotifiers = new Map<string, () => void>();

const SOURCE_DENIED: PreviewResponse = {
  ok: false,
  code: 'permission',
  error: 'Access to the page containing this link has been removed or was not granted.',
};

function settledResponse(waiterKey: string): PreviewResponse | undefined {
  const state = settledWaiters.get(waiterKey);
  if (state === 'source') return SOURCE_DENIED;
  if (state === 'destination') return PERMISSION_DENIED;
  if (state === 'cancelled') return CANCELLED;
  return undefined;
}

function settleWaiter(waiterKey: string, state: 'cancelled' | 'source' | 'destination'): void {
  if (settledWaiters.has(waiterKey)) return;
  settledWaiters.set(waiterKey, state);
  waiterNotifiers.get(waiterKey)?.();
  // Bound stray tombstones; state belonging to a live request always survives.
  if (settledWaiters.size > 512) {
    for (const key of settledWaiters.keys()) {
      if (settledWaiters.size <= 512) break;
      if (!waiterSources.has(key) && !waiterDestinations.has(key)) settledWaiters.delete(key);
    }
  }
}

async function hasOriginPermission(url: URL): Promise<boolean> {
  return chrome.permissions.contains({ origins: [urlOriginPattern(url)] }).catch(() => false);
}

function startLoad(url: URL): PendingPreview {
  let abortFetch: (() => void) | undefined;
  const entry: PendingPreview = {
    waiters: new Set(),
    cancel: () => abortFetch?.(),
    promise: Promise.resolve(PERMISSION_DENIED),
  };
  pending.set(url.href, entry);
  entry.promise = (async () => {
    try {
      const cached = readCache(url.href);
      if (cached) return cached;
      try {
        const request = fetchHtml(url);
        abortFetch = request.cancel;
        const { html, finalUrl, frame } = await request.promise;
        abortFetch = undefined;
        // The destination grant may have been revoked while fetching.
        if (!await hasOriginPermission(url)) return PERMISSION_DENIED;
        const response: PreviewResponse = { ok: true, data: parseMetadata(html, finalUrl), frame };
        // A detached entry (cancelled or evicted) may not write to the cache.
        if (pending.get(url.href) === entry) writeCache(url.href, response);
        return response;
      } catch (error) {
        const response = failureResponse(error);
        if (!response.ok && !transientFailures.has(response.code) && await hasOriginPermission(url)
          && pending.get(url.href) === entry) {
          writeCache(url.href, response);
        }
        return response;
      }
    } finally {
      if (pending.get(url.href) === entry) pending.delete(url.href);
    }
  })();
  return entry;
}

function getPreview(url: URL, waiterKey: string, source: URL): Promise<PreviewResponse> {
  return (async () => {
    // Destination access is verified before reusing any in-flight request.
    if (!await hasOriginPermission(url)) return settledResponse(waiterKey) ?? PERMISSION_DENIED;
    const early = settledResponse(waiterKey);
    if (early) return early;
    let entry = pending.get(url.href);
    if (!entry) entry = startLoad(url);
    entry.waiters.add(waiterKey);
    const settledSignal = new Promise<PreviewResponse>(resolve => {
      waiterNotifiers.set(waiterKey, () => resolve(settledResponse(waiterKey) ?? CANCELLED));
      const already = settledResponse(waiterKey);
      if (already) resolve(already);
    });
    try {
      const response = await Promise.race([entry.promise, settledSignal]);
      const settled = settledResponse(waiterKey);
      if (settled) return settled;
      // Both grants are re-verified immediately before delivery.
      const [sourceOk, destinationOk] = await Promise.all([hasOriginPermission(source), hasOriginPermission(url)]);
      const late = settledResponse(waiterKey);
      if (late) return late;
      if (!sourceOk) return SOURCE_DENIED;
      if (!destinationOk) return PERMISSION_DENIED;
      return response;
    } finally {
      waiterNotifiers.delete(waiterKey);
      if (entry.waiters.delete(waiterKey) && entry.waiters.size === 0 && pending.get(url.href) === entry) {
        pending.delete(url.href);
        entry.cancel();
      }
    }
  })().catch(failureResponse);
}

function cancelWaiter(waiterKey: string): void {
  settleWaiter(waiterKey, 'cancelled');
  for (const [key, entry] of pending) {
    if (!entry.waiters.delete(waiterKey)) continue;
    if (entry.waiters.size === 0) {
      pending.delete(key);
      entry.cancel();
    }
    return;
  }
}

async function handlePreviewRequest(url: string, sourceUrl: string | undefined, waiterKey: string): Promise<PreviewResponse> {
  try {
    let source: URL | null = null;
    try {
      if (sourceUrl) source = new URL(sourceUrl);
    } catch {
      source = null;
    }
    if (!source || !['http:', 'https:'].includes(source.protocol)) return SOURCE_DENIED;
    waiterSources.set(waiterKey, source);
    // The destination is registered before the first await so a revoke during
    // any later check settles this request instead of letting it proceed.
    let destination: URL | null = null;
    let destinationError: PreviewResponse | null = null;
    try {
      destination = assertPublicUrl(url);
    } catch (error) {
      destinationError = failureResponse(error);
    }
    if (destination) waiterDestinations.set(waiterKey, destination);
    const early = settledResponse(waiterKey);
    if (early) return early;
    if (!await hasOriginPermission(source)) return settledResponse(waiterKey) ?? SOURCE_DENIED;
    const mid = settledResponse(waiterKey);
    if (mid) return mid;
    if (!destination) return destinationError ?? SOURCE_DENIED;
    return await getPreview(destination, waiterKey, source);
  } finally {
    liveWaiterKeys.delete(waiterKey);
    waiterSources.delete(waiterKey);
    waiterDestinations.delete(waiterKey);
    settledWaiters.delete(waiterKey);
  }
}

export default defineBackground(() => {
  schedulePreviewRegistration();
  chrome.permissions.onAdded.addListener(schedulePreviewRegistration);
  chrome.permissions.onRemoved.addListener(permissions => {
    dropRevokedOrigins(permissions.origins ?? []);
    schedulePreviewRegistration();
  });
  chrome.tabs.onRemoved.addListener(tabId => {
    const prefix = `${tabId}:`;
    for (const key of Array.from(liveWaiterKeys)) {
      if (key.startsWith(prefix)) cancelWaiter(key);
    }
  });

  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse: (response: PreviewResponse) => void) => {
    if (!message || typeof message !== 'object' || !('type' in message)) return false;
    if (sender.id !== chrome.runtime.id) return false;
    // Scope waiters by document so a navigation cannot cancel another document's request IDs.
    const owner = `${sender.tab?.id}:${sender.documentId ?? `f${sender.frameId ?? 0}`}`;
    if (message.type === 'PEEKLINK_CANCEL') {
      const requestId = 'requestId' in message ? message.requestId : undefined;
      if (typeof sender.tab?.id === 'number' && typeof requestId === 'number') {
        cancelWaiter(`${owner}:${requestId}`);
      }
      return false;
    }
    if (message.type === 'PEEKLINK_OPEN_SETTINGS') {
      void chrome.runtime.openOptionsPage();
      return false;
    }
    if (message.type !== 'PEEKLINK_PREVIEW' || !sender.tab?.id) return false;
    const url = 'url' in message ? message.url : undefined;
    if (typeof url !== 'string') return false;
    const waiterKey = `${owner}:${'requestId' in message && typeof message.requestId === 'number' ? message.requestId : `anon-${++anonymousWaiter}`}`;
    if (liveWaiterKeys.has(waiterKey)) {
      try {
        sendResponse({ ok: false, code: 'unavailable', error: 'A preview request with this ID is already in progress.' });
      } catch {
        // The message channel may already be gone.
      }
      return false;
    }
    liveWaiterKeys.add(waiterKey);
    void handlePreviewRequest(url, sender.tab?.url ?? sender.url, waiterKey)
      .catch(failureResponse)
      .then(response => {
        try {
          sendResponse(response);
        } catch {
          // The message channel may already be gone.
        }
      });
    return true;
  });

  chrome.action.onClicked.addListener(() => {
    void chrome.runtime.openOptionsPage();
  });
});
