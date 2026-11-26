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
const MAX_REDIRECTS = 5;
const REDIRECT_OBSERVATION_GRACE = 30;
const REDIRECT_OBSERVATION_TTL = 10_000;

const transientFailures = new Set<PreviewErrorCode>(['network', 'timeout', 'queue-full', 'cancelled', 'permission']);

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
  targets: Set<string>;
}

interface CachedPreview {
  response: PreviewResponse;
  expires: number;
  targets: string[];
}

interface RedirectObservation {
  redirectUrl: string;
  timeStamp: number;
}

const queue = new RequestQueue();
const cache = new Map<string, CachedPreview>();
const pending = new Map<string, PendingPreview>();
const observedRedirects = new Map<string, RedirectObservation[]>();
const fetchTurns = new Map<string, Promise<void>>();
let anonymousWaiter = 0;
const CONTENT_SCRIPT_ID = 'peeklink-preview';
let registrationSync: Promise<void> = Promise.resolve();

// The registration persists across browser sessions while the worker does
// not, and the scripting API is the only trustworthy record of it. A stored
// fingerprint could skip the live-state query instead, but any write failure
// can leave a "completed" snapshot that no longer matches what is actually
// registered — e.g. a revoke whose unregister lands while session storage is
// down — and a stale hit then suppresses registration for the rest of the
// browser session. So every sync reads the live registration and reconciles:
// an identical registration skips the mutating IPCs, anything else registers,
// updates, or unregisters.
async function syncPreviewRegistration(): Promise<void> {
  const permissions = await chrome.permissions.getAll();
  const origins = permissions.origins ?? [];
  const current = (await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] }))
    .find(script => script.id === CONTENT_SCRIPT_ID);

  if (origins.length === 0) {
    if (current) await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    return;
  }

  const script = {
    id: CONTENT_SCRIPT_ID,
    js: ['preview.js'],
    matches: origins,
    runAt: 'document_idle' as const,
    persistAcrossSessions: true,
  };

  const inSync = current !== undefined
    && JSON.stringify([...(current.matches ?? [])].sort()) === JSON.stringify([...origins].sort())
    && JSON.stringify(current.js ?? []) === JSON.stringify(script.js)
    && !(current.css?.length) && !(current.excludeMatches?.length)
    && (current.runAt ?? 'document_idle') === script.runAt
    && current.persistAcrossSessions === true
    && !current.allFrames && !current.matchOriginAsFallback
    && (current.world ?? 'ISOLATED') === 'ISOLATED';
  if (inSync) return;
  if (current) await chrome.scripting.updateContentScripts([script]);
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

function originRevocationPredicate(patterns: string[]): (key: string) => boolean {
  return (key: string) => {
    try {
      return patterns.some(pattern => originMatchesPattern(new URL(key), pattern));
    } catch {
      return false;
    }
  };
}

function pruneCacheForRevokedOrigins(revoked: (key: string) => boolean): boolean {
  let dropped = false;
  for (const [key, entry] of cache) {
    if (revoked(key) || entry.targets.some(revoked)) {
      cache.delete(key);
      dropped = true;
    }
  }
  return dropped;
}

function dropRevokedOrigins(patterns: string[]): void {
  if (patterns.length === 0) return;
  // A revocation that arrives while the session snapshot is still loading
  // prunes a cache the restored entries are not part of yet; remember it so
  // ensureCacheRestored can apply it to the imported entries too.
  pendingRevokedPatterns?.push(...patterns);
  const revoked = originRevocationPredicate(patterns);
  if (pruneCacheForRevokedOrigins(revoked)) persistCache();
  // Revoked grants settle matching waiters for the rest of the request
  // lifetime — a later regrant cannot revive them.
  for (const [waiterKey, source] of waiterSources) {
    if (revoked(source.href)) settleWaiter(waiterKey, 'source');
  }
  for (const [waiterKey, destinations] of waiterDestinations) {
    if ([...destinations].some(revoked)) settleWaiter(waiterKey, 'destination');
  }
  for (const [key, entry] of pending) {
    if (revoked(key) || [...entry.targets].some(revoked)) {
      for (const waiterKey of entry.waiters) settleWaiter(waiterKey, 'destination');
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

const enum ScanState {
  Data,
  TagOpen,
  Bang,
  BangDash,
  CommentStart,
  CommentStartDash,
  Comment,
  CommentDash,
  CommentDashDash,
  CommentEndBang,
  BogusComment,
  EndTagOpen,
  StartTagName,
  EndTagName,
  TagBeforeAttrName,
  TagAttrName,
  TagAfterAttrName,
  TagBeforeValue,
  TagUnquoted,
  TagAttrSQ,
  TagAttrDQ,
  TagAfterQuotedValue,
  TagSelfClosing,
  Rawtext,
  RawtextLT,
  CloseOpen,
  CloseName,
  CloseBoundary,
  ScriptData,
  ScriptLT,
  ScriptBang,
  ScriptBangDash,
  ScriptEscaped,
  ScriptEscapedDash,
  ScriptEscapedDashDash,
  ScriptEscapedLT,
  ScriptDoubleEscStart,
  ScriptDoubleEscStartBoundary,
  ScriptDoubleEscaped,
  ScriptDoubleEscapedDash,
  ScriptDoubleEscapedDashDash,
  ScriptDoubleEscapedLT,
  CdataOpen,
  Cdata,
  CdataBracket,
  CdataBracketBracket,
}

const RAWTEXT_TAGS = new Set(['script', 'style', 'title', 'textarea']);
const LT = 0x3c; // <
const GT = 0x3e; // >
const SLASH = 0x2f;
const DASH = 0x2d;
const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d;
const isNameBoundary = (b: number) => isWs(b) || b === SLASH || b === GT;

// Byte-level HTML scanner that reports where metadata-bearing content ends:
// a real </head> or <body> tag in data state. It skips comments, CDATA,
// quoted attribute values, and style/title/textarea contents. Script contents
// follow the HTML escaped and double-escaped states, so an inner "</script>"
// that only ends a double escape does not close the element. XML documents
// (XHTML) have no rawtext elements, so self-closing scripts need no special
// handling there. Chunk boundaries are irrelevant because the state persists
// across feeds. Bytes are matched as ASCII, which works in every
// ASCII-compatible charset; UTF-16 pages simply never match and fall through
// to the byte cap. When in doubt the scanner keeps reading — a missed end
// only degrades to cap truncation, while a false end would lose metadata.
class HeadEndScanner {
  private state = ScanState.Data;
  private name = '';
  private pendingRawtext: string | null = null;
  private rawtextName = '';
  private matchPos = 0;
  private closeReturn = ScanState.Rawtext;
  private closeIsDoubleEscapeEnd = false;
  private attrTagIsEnd = false;

  constructor(private readonly xml: boolean) {}

  feed(bytes: Uint8Array): boolean {
    for (const byte of bytes) {
      if (this.step(byte)) return true;
    }
    return false;
  }

  private beginAttrs(isEnd: boolean, boundary: number): void {
    this.attrTagIsEnd = isEnd;
    this.state = boundary === SLASH ? ScanState.TagSelfClosing : ScanState.TagBeforeAttrName;
  }

  private openClose(returnTo: ScanState, doubleEscapeEnd: boolean): void {
    this.closeReturn = returnTo;
    this.closeIsDoubleEscapeEnd = doubleEscapeEnd;
    this.state = ScanState.CloseOpen;
  }

  private step(b: number): boolean {
    const lc = b | 0x20; // ASCII letters only: exact target bits, so no non-letter collides
    const isLetter = lc >= 0x61 && lc <= 0x7a;
    switch (this.state) {
      case ScanState.Data:
        if (b === LT) this.state = ScanState.TagOpen;
        return false;
      case ScanState.TagOpen:
        if (b === SLASH) this.state = ScanState.EndTagOpen;
        else if (b === 0x21) this.state = ScanState.Bang;
        else if (b === 0x3f) this.state = ScanState.BogusComment;
        else if (isLetter) {
          this.state = ScanState.StartTagName;
          this.name = String.fromCharCode(lc);
        } else if (b !== LT) this.state = ScanState.Data;
        return false;
      case ScanState.Bang:
        // Bogus comments (including doctypes, which end at the same ">") are
        // skipped as a unit so marker-like text inside them stays inert.
        if (b === DASH) this.state = ScanState.BangDash;
        else if (this.xml && b === 0x5b) {
          this.matchPos = 0;
          this.state = ScanState.CdataOpen;
        } else this.state = b === GT ? ScanState.Data : ScanState.BogusComment;
        return false;
      case ScanState.BogusComment:
        if (b === GT) this.state = ScanState.Data;
        return false;
      case ScanState.BangDash:
        if (b === DASH) this.state = ScanState.CommentStart;
        else this.state = b === GT ? ScanState.Data : ScanState.BogusComment;
        return false;
      case ScanState.CommentStart:
        // Abruptly closed comments: "<!-->" and "<!--->" end immediately.
        if (b === GT) this.state = ScanState.Data;
        else if (b === DASH) this.state = ScanState.CommentStartDash;
        else this.state = ScanState.Comment;
        return false;
      case ScanState.CommentStartDash:
        if (b === GT) this.state = ScanState.Data;
        else if (b === DASH) this.state = ScanState.CommentDashDash;
        else this.state = ScanState.Comment;
        return false;
      case ScanState.Comment:
        if (b === DASH) this.state = ScanState.CommentDash;
        return false;
      case ScanState.CommentDash:
        this.state = b === DASH ? ScanState.CommentDashDash : ScanState.Comment;
        return false;
      case ScanState.CommentDashDash:
        if (b === GT) this.state = ScanState.Data;
        else if (b === 0x21) this.state = ScanState.CommentEndBang;
        else if (b !== DASH) this.state = ScanState.Comment;
        return false;
      case ScanState.CommentEndBang:
        if (b === GT) this.state = ScanState.Data;
        else if (b === DASH) this.state = ScanState.CommentDash;
        else this.state = ScanState.Comment;
        return false;
      case ScanState.CdataOpen:
        if (b === 'CDATA['.charCodeAt(this.matchPos)) {
          this.matchPos += 1;
          if (this.matchPos === 6) this.state = ScanState.Cdata;
        } else this.state = ScanState.Data;
        return false;
      case ScanState.Cdata:
        if (b === 0x5d) this.state = ScanState.CdataBracket;
        return false;
      case ScanState.CdataBracket:
        this.state = b === 0x5d ? ScanState.CdataBracketBracket : ScanState.Cdata;
        return false;
      case ScanState.CdataBracketBracket:
        if (b === GT) this.state = ScanState.Data;
        else if (b !== 0x5d) this.state = ScanState.Cdata;
        return false;
      case ScanState.EndTagOpen:
        if (isLetter) {
          this.state = ScanState.EndTagName;
          this.name = String.fromCharCode(lc);
        } else this.state = b === GT ? ScanState.Data : ScanState.BogusComment;
        return false;
      case ScanState.StartTagName:
        if (isNameBoundary(b)) {
          if (this.name === 'body') return true;
          this.pendingRawtext = !this.xml && RAWTEXT_TAGS.has(this.name) ? this.name : null;
          if (b === GT) this.endStartTag();
          else this.beginAttrs(false, b);
        } else if (this.name.length < 16) {
          this.name += String.fromCharCode(isLetter ? lc : b);
        }
        return false;
      case ScanState.EndTagName:
        if (isNameBoundary(b)) {
          if (this.name === 'head') return true;
          if (b === GT) this.state = ScanState.Data;
          else this.beginAttrs(true, b);
        } else if (this.name.length < 16) {
          this.name += String.fromCharCode(isLetter ? lc : b);
        }
        return false;
      case ScanState.TagBeforeAttrName:
        if (isWs(b)) return false;
        if (b === SLASH) this.state = ScanState.TagSelfClosing;
        else if (b === GT) this.endTag();
        else {
          // At an attribute's start even "=" is part of the malformed name;
          // it only separates a value once a name has already begun.
          this.state = ScanState.TagAttrName;
        }
        return false;
      case ScanState.TagAttrName:
        if (b === 0x3d) this.state = ScanState.TagBeforeValue;
        else if (isWs(b) || b === SLASH || b === GT) {
          this.state = ScanState.TagAfterAttrName;
          return this.step(b);
        }
        return false;
      case ScanState.TagAfterAttrName:
        if (isWs(b)) return false;
        if (b === SLASH) this.state = ScanState.TagSelfClosing;
        else if (b === 0x3d) this.state = ScanState.TagBeforeValue;
        else if (b === GT) this.endTag();
        else {
          this.state = ScanState.TagAttrName;
          return this.step(b);
        }
        return false;
      case ScanState.TagBeforeValue:
        if (b === 0x22) this.state = ScanState.TagAttrDQ;
        else if (b === 0x27) this.state = ScanState.TagAttrSQ;
        else if (b === GT) this.endTag();
        else if (!isWs(b)) this.state = ScanState.TagUnquoted;
        return false;
      case ScanState.TagUnquoted:
        if (b === GT) this.endTag();
        else if (isWs(b)) this.state = ScanState.TagBeforeAttrName;
        return false;
      case ScanState.TagAttrSQ:
        if (b === 0x27) this.state = ScanState.TagAfterQuotedValue;
        return false;
      case ScanState.TagAttrDQ:
        if (b === 0x22) this.state = ScanState.TagAfterQuotedValue;
        return false;
      case ScanState.TagAfterQuotedValue:
        if (isWs(b)) this.state = ScanState.TagBeforeAttrName;
        else if (b === SLASH) this.state = ScanState.TagSelfClosing;
        else if (b === GT) this.endTag();
        else {
          this.state = ScanState.TagBeforeAttrName;
          return this.step(b);
        }
        return false;
      case ScanState.TagSelfClosing:
        if (b === GT) this.endTag();
        else {
          this.state = ScanState.TagBeforeAttrName;
          return this.step(b);
        }
        return false;
      case ScanState.Rawtext:
        if (b === LT) this.state = ScanState.RawtextLT;
        return false;
      case ScanState.RawtextLT:
        if (b === SLASH) this.openClose(ScanState.Rawtext, false);
        else if (b !== LT) this.state = ScanState.Rawtext;
        return false;
      case ScanState.CloseOpen:
        if (isLetter && lc === this.rawtextName.charCodeAt(0)) {
          this.matchPos = 1;
          this.state = ScanState.CloseName;
          return false;
        }
        // A failed candidate is text: the current byte is reconsumed in the
        // state the scanner returns to, so an overlapping "<" or dash is not lost.
        this.state = this.closeReturn;
        return this.step(b);
      case ScanState.CloseName:
        if (isLetter && lc === this.rawtextName.charCodeAt(this.matchPos)) {
          this.matchPos += 1;
          if (this.matchPos === this.rawtextName.length) this.state = ScanState.CloseBoundary;
          return false;
        }
        this.state = this.closeReturn;
        return this.step(b);
      case ScanState.CloseBoundary:
        if (this.closeIsDoubleEscapeEnd) {
          // Inside a double-escaped script section "</script" is text, not a
          // tag: it merely returns the script to the escaped state.
          if (isNameBoundary(b)) this.state = ScanState.ScriptEscaped;
          else {
            this.state = this.closeReturn;
            return this.step(b);
          }
        } else if (b === GT) this.state = ScanState.Data;
        else if (isWs(b) || b === SLASH) this.beginAttrs(true, b);
        else {
          this.state = this.closeReturn;
          return this.step(b);
        }
        return false;
      case ScanState.ScriptData:
        if (b === LT) this.state = ScanState.ScriptLT;
        return false;
      case ScanState.ScriptLT:
        if (b === SLASH) this.openClose(ScanState.ScriptData, false);
        else if (b === 0x21) this.state = ScanState.ScriptBang;
        else if (b !== LT) this.state = ScanState.ScriptData;
        return false;
      case ScanState.ScriptBang:
        if (b === DASH) {
          this.state = ScanState.ScriptBangDash;
          return false;
        }
        this.state = ScanState.ScriptData;
        return this.step(b);
      case ScanState.ScriptBangDash:
        if (b === DASH) {
          this.state = ScanState.ScriptEscapedDashDash;
          return false;
        }
        this.state = ScanState.ScriptData;
        return this.step(b);
      case ScanState.ScriptEscaped:
        if (b === DASH) this.state = ScanState.ScriptEscapedDash;
        else if (b === LT) this.state = ScanState.ScriptEscapedLT;
        return false;
      case ScanState.ScriptEscapedDash:
        if (b === DASH) this.state = ScanState.ScriptEscapedDashDash;
        else if (b === LT) this.state = ScanState.ScriptEscapedLT;
        else this.state = ScanState.ScriptEscaped;
        return false;
      case ScanState.ScriptEscapedDashDash:
        if (b === GT) this.state = ScanState.ScriptData;
        else if (b === LT) this.state = ScanState.ScriptEscapedLT;
        else if (b !== DASH) this.state = ScanState.ScriptEscaped;
        return false;
      case ScanState.ScriptEscapedLT:
        if (b === SLASH) this.openClose(ScanState.ScriptEscaped, false);
        else if (isLetter && lc === 0x73) {
          this.matchPos = 1;
          this.state = ScanState.ScriptDoubleEscStart;
        } else if (b !== LT) {
          // Anything else is script text: the byte is reconsumed so a dash
          // still counts toward a closing "-->".
          this.state = ScanState.ScriptEscaped;
          return this.step(b);
        }
        return false;
      case ScanState.ScriptDoubleEscStart:
        if (isLetter && lc === this.rawtextName.charCodeAt(this.matchPos)) {
          this.matchPos += 1;
          if (this.matchPos === this.rawtextName.length) this.state = ScanState.ScriptDoubleEscStartBoundary;
          return false;
        }
        this.state = ScanState.ScriptEscaped;
        return this.step(b);
      case ScanState.ScriptDoubleEscStartBoundary:
        if (isNameBoundary(b)) {
          this.state = ScanState.ScriptDoubleEscaped;
          return false;
        }
        this.state = ScanState.ScriptEscaped;
        return this.step(b);
      case ScanState.ScriptDoubleEscaped:
        if (b === DASH) this.state = ScanState.ScriptDoubleEscapedDash;
        else if (b === LT) this.state = ScanState.ScriptDoubleEscapedLT;
        return false;
      case ScanState.ScriptDoubleEscapedDash:
        if (b === DASH) this.state = ScanState.ScriptDoubleEscapedDashDash;
        else if (b === LT) this.state = ScanState.ScriptDoubleEscapedLT;
        else this.state = ScanState.ScriptDoubleEscaped;
        return false;
      case ScanState.ScriptDoubleEscapedDashDash:
        if (b === GT) this.state = ScanState.ScriptData;
        else if (b === LT) this.state = ScanState.ScriptDoubleEscapedLT;
        else if (b !== DASH) this.state = ScanState.ScriptDoubleEscaped;
        return false;
      case ScanState.ScriptDoubleEscapedLT:
        if (b === SLASH) this.openClose(ScanState.ScriptDoubleEscaped, true);
        else if (b !== LT) {
          this.state = ScanState.ScriptDoubleEscaped;
          return this.step(b);
        }
        return false;
    }
  }

  private endTag(): void {
    if (this.attrTagIsEnd) this.state = ScanState.Data;
    else this.endStartTag();
  }

  private endStartTag(): void {
    if (this.pendingRawtext === 'script') {
      this.rawtextName = 'script';
      this.state = ScanState.ScriptData;
    } else if (this.pendingRawtext) {
      this.rawtextName = this.pendingRawtext;
      this.state = ScanState.Rawtext;
    } else {
      this.state = ScanState.Data;
    }
    this.pendingRawtext = null;
  }
}

// Metadata lives in <head>, so reading stops as soon as its end is seen;
// otherwise the page is silently truncated at the cap. Either way the regex
// metadata parser works fine on the partial document, so heavy pages degrade
// to whatever metadata their head carried instead of failing outright.
async function readBoundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new PreviewFailure('network', 'The website returned an empty response.');

  const reader = response.body.getReader();
  const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
  const scanner = new HeadEndScanner(contentType.includes('application/xhtml+xml'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  let headEndSeen = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = total + value.byteLength > limit ? value.subarray(0, limit - total) : value;
      if (scanner.feed(chunk)) headEndSeen = true;
      chunks.push(chunk);
      total += chunk.byteLength;
      if (headEndSeen || total >= limit) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
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

function pruneObservedRedirects(now = Date.now()): void {
  for (const [url, observations] of observedRedirects) {
    const fresh = observations.filter(observation => now - observation.timeStamp <= REDIRECT_OBSERVATION_TTL);
    if (fresh.length > 0) observedRedirects.set(url, fresh);
    else observedRedirects.delete(url);
  }
}

function consumeObservedRedirect(url: URL, startedAt: number): string | undefined {
  pruneObservedRedirects();
  const observations = observedRedirects.get(url.href);
  if (!observations) return undefined;
  const index = observations.findIndex(observation => observation.timeStamp >= startedAt - 1);
  if (index === -1) return undefined;
  const [observation] = observations.splice(index, 1);
  if (observations.length === 0) observedRedirects.delete(url.href);
  return observation?.redirectUrl;
}

async function observedRedirectUrl(url: URL, startedAt: number): Promise<string | undefined> {
  const immediate = consumeObservedRedirect(url, startedAt);
  if (immediate) return immediate;
  await new Promise(resolve => { setTimeout(resolve, REDIRECT_OBSERVATION_GRACE); });
  return consumeObservedRedirect(url, startedAt);
}

// Serializes fetches per URL so a redirect observation cannot be consumed by
// the wrong concurrent request. The turn is held until the observation is
// consumed; stale observations are cleared when the turn is acquired. Waiting
// is abort-aware: an aborted waiter gives up its place without entering the
// critical section, while the chain still ties successors to the holder that
// is actually running, so cancelling never overtakes it.
async function withFetchTurn<T>(url: URL, signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  const previous = fetchTurns.get(url.href) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  const tail = previous.then(() => current);
  fetchTurns.set(url.href, tail);
  // The map entry is only dropped once this position in the chain has fully
  // settled — never while an earlier holder may still be running.
  void tail.then(() => {
    if (fetchTurns.get(url.href) === tail) fetchTurns.delete(url.href);
  });

  const aborted = new Promise<never>((_, reject) => {
    if (signal.aborted) reject(new DOMException('Aborted', 'AbortError'));
    else signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  try {
    await Promise.race([previous, aborted]);
  } catch (error) {
    release();
    throw error;
  }
  try {
    return await task();
  } finally {
    release();
  }
}

function observeRedirectHeaders(details: chrome.webRequest.WebResponseHeadersDetails): void {
  const extensionOrigin = chrome.runtime.getURL('').replace(/\/$/, '');
  if (details.tabId !== -1 || details.type !== 'xmlhttprequest' || details.method !== 'GET' || details.initiator !== extensionOrigin) return;
  if (![301, 302, 303, 307, 308].includes(details.statusCode)) return;
  const redirectUrl = details.responseHeaders?.find(header => header.name.toLowerCase() === 'location')?.value;
  if (!redirectUrl) return;
  pruneObservedRedirects();
  const observations = observedRedirects.get(details.url) ?? [];
  observations.push({ redirectUrl, timeStamp: details.timeStamp });
  while (observations.length > 8) observations.shift();
  observedRedirects.set(details.url, observations);
}

let redirectObserverUses = 0;

function retainRedirectObserver(): void {
  if (redirectObserverUses++ === 0) {
    chrome.webRequest?.onHeadersReceived.addListener(
      observeRedirectHeaders,
      { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest'], tabId: -1 },
      ['responseHeaders'],
    );
  }
}

function releaseRedirectObserver(): void {
  redirectObserverUses = Math.max(0, redirectObserverUses - 1);
  if (redirectObserverUses === 0) chrome.webRequest?.onHeadersReceived.removeListener(observeRedirectHeaders);
}

function fetchHtml(url: URL, targets: Set<string>): { promise: Promise<{ html: string; finalUrl: string; frame: FramePolicy }>; cancel: () => void } {
  return queue.run(async signal => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const propagate = () => controller.abort();
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', propagate, { once: true });
    retainRedirectObserver();
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
      let redirectCount = 0;
      let slashProbeUsed = false;
      const seen = new Set([url.href]);

      while (true) {
        targets.add(target.href);
        if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
        const { response, redirectUrl } = await withFetchTurn(target, controller.signal, async () => {
          const startedAt = Date.now();
          // Only this request can be in flight for this URL now, so anything
          // already observed is stale and must not be consumed here.
          observedRedirects.delete(target.href);
          const response = await request(target);
          if (response.type !== 'opaqueredirect') return { response, redirectUrl: undefined };
          await response.body?.cancel().catch(() => undefined);
          return { response, redirectUrl: await observedRedirectUrl(target, startedAt) };
        });
        if (response.type !== 'opaqueredirect') {
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
        }

        if (redirectUrl) {
          redirectCount += 1;
          if (redirectCount > MAX_REDIRECTS) {
            throw new PreviewFailure('redirect', 'This link redirects too many times. Open it in a new tab.');
          }
          let resolved: string;
          try {
            resolved = new URL(redirectUrl, target.href).href;
          } catch {
            throw new PreviewFailure('redirect', 'This link redirects to an invalid address. Open it in a new tab.');
          }
          const next = assertPublicUrl(resolved);
          if (seen.has(next.href)) {
            throw new PreviewFailure('redirect', 'This link redirects in a loop. Open it in a new tab.');
          }
          seen.add(next.href);
          targets.add(next.href);
          if (!await hasOriginPermission(next)) {
            throw new PreviewFailure('permission', `This link redirects to ${next.hostname}, which is not allowed in PeekLink settings.`);
          }
          target = next;
          continue;
        }

        // Fetch hides the Location header. Probe only the same path's slash variant.
        if (!slashProbeUsed && target.href === url.href && url.pathname !== '/') {
          slashProbeUsed = true;
          target = new URL(url.href);
          target.pathname = url.pathname.endsWith('/') ? url.pathname.slice(0, -1) : `${url.pathname}/`;
          continue;
        }
        throw new PreviewFailure('redirect', 'This link redirects to another address. Open it in a new tab.');
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw signal.aborted
          ? new PreviewFailure('cancelled', 'The preview request was cancelled.')
          : new PreviewFailure('timeout', 'The preview request timed out.');
      }
      throw error;
    } finally {
      releaseRedirectObserver();
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

function readCacheEntry(key: string): CachedPreview | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

const SESSION_CACHE_KEY = 'previewCache';
let cacheRestore: Promise<void> | undefined;
// Revocations observed until the session snapshot finishes restoring; null
// afterwards. See dropRevokedOrigins and ensureCacheRestored.
let pendingRevokedPatterns: string[] | null = [];

function sessionCacheArea(): chrome.storage.StorageArea | undefined {
  try {
    return chrome.storage?.session;
  } catch {
    return undefined;
  }
}

function isCachedPreview(value: unknown): value is CachedPreview {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Partial<CachedPreview>;
  return typeof entry.expires === 'number'
    && Array.isArray(entry.targets) && entry.targets.every(target => typeof target === 'string')
    && Boolean(entry.response) && typeof entry.response === 'object' && typeof entry.response.ok === 'boolean';
}

// The in-memory cache dies with the service worker (~30s idle in MV3), which
// would cut the 15-minute TTL down to about a minute of real reuse. Mirror it
// to session storage — memory-backed, cleared with the browser session — and
// restore it on the next cold start.
function ensureCacheRestored(): Promise<void> {
  cacheRestore ??= (async () => {
    const area = sessionCacheArea();
    if (!area) {
      pendingRevokedPatterns = null;
      return;
    }
    try {
      const stored: unknown = (await area.get(SESSION_CACHE_KEY))[SESSION_CACHE_KEY];
      if (stored && typeof stored === 'object') {
        const now = Date.now();
        for (const [key, entry] of Object.entries(stored)) {
          // Live entries written since startup are fresher than the snapshot.
          if (cache.has(key) || !isCachedPreview(entry) || entry.expires <= now) continue;
          cache.set(key, entry);
        }
      }
      // Revocations that fired while the snapshot was loading pruned a cache
      // these entries were not part of; apply them before serving anything.
      if (pendingRevokedPatterns?.length && pruneCacheForRevokedOrigins(originRevocationPredicate(pendingRevokedPatterns))) {
        const snapshot: Record<string, CachedPreview> = {};
        for (const [key, entry] of cache) snapshot[key] = entry;
        await area.set({ [SESSION_CACHE_KEY]: snapshot }).catch(() => undefined);
      }
    } catch {
      // Session storage is best-effort; the in-memory cache still works.
    } finally {
      pendingRevokedPatterns = null;
    }
  })();
  return cacheRestore;
}

function persistCache(): void {
  const area = sessionCacheArea();
  if (!area) return;
  // Wait out any pending restore so the snapshot never drops restored entries.
  void ensureCacheRestored().then(() => {
    const snapshot: Record<string, CachedPreview> = {};
    for (const [key, entry] of cache) snapshot[key] = entry;
    return area.set({ [SESSION_CACHE_KEY]: snapshot });
  }).catch(() => undefined);
}

function writeCache(key: string, response: PreviewResponse, targets = [key]): void {
  cache.delete(key);
  cache.set(key, { response, expires: Date.now() + (response.ok ? SUCCESS_TTL : FAILURE_TTL), targets });
  const now = Date.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expires <= now) cache.delete(entryKey);
  }
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (typeof oldest !== 'string') break;
    cache.delete(oldest);
  }
  persistCache();
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
// Every URL whose revocation must settle the waiter: starts with the original
// destination and grows to the full redirect chain once it is known.
const waiterDestinations = new Map<string, Set<string>>();
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

// Grant answers are cached per origin pattern for the worker's lifetime; a
// permission event invalidates the whole map before anything else handles it.
// A pending promise is shared, so parallel checks for one origin cost one IPC.
// Only grants may outlive their call: a denial — or a failed IPC, which fails
// closed — is re-queried next time rather than risking a stale "false".
const originGrants = new Map<string, Promise<boolean>>();

function invalidateOriginGrants(): void {
  originGrants.clear();
}

async function hasOriginPermission(url: URL): Promise<boolean> {
  const pattern = urlOriginPattern(url);
  const pending = originGrants.get(pattern);
  if (pending) return pending;
  const query = chrome.permissions.contains({ origins: [pattern] }).then(
    granted => {
      // An evicted entry is only removed while this query is still the map's
      // own: after an invalidation the get() guard fails, so a stale promise
      // cannot drop a fresher query for the same pattern.
      if (!granted && originGrants.get(pattern) === query) originGrants.delete(pattern);
      return granted;
    },
    () => {
      if (originGrants.get(pattern) === query) originGrants.delete(pattern);
      return false;
    },
  );
  originGrants.set(pattern, query);
  if (originGrants.size > 512) {
    const oldest = originGrants.keys().next().value;
    if (oldest !== undefined) originGrants.delete(oldest);
  }
  return query;
}

function startLoad(url: URL): PendingPreview {
  let abortFetch: (() => void) | undefined;
  const entry: PendingPreview = {
    waiters: new Set(),
    cancel: () => abortFetch?.(),
    promise: Promise.resolve(PERMISSION_DENIED),
    targets: new Set([url.href]),
  };
  pending.set(url.href, entry);
  entry.promise = (async () => {
    try {
      await ensureCacheRestored();
      // Cancellation or revocation while the session snapshot was loading
      // detached this entry before the fetch existed; every detach path
      // removes it from `pending`, so don't fetch for waiters that are gone.
      if (pending.get(url.href) !== entry) return CANCELLED;
      const cached = readCacheEntry(url.href);
      if (cached) {
        for (const target of cached.targets) entry.targets.add(target);
        return cached.response;
      }
      try {
        const request = fetchHtml(url, entry.targets);
        abortFetch = request.cancel;
        const { html, finalUrl, frame } = await request.promise;
        abortFetch = undefined;
        // The destination grant may have been revoked while fetching.
        const [originOk, finalOk] = await Promise.all([hasOriginPermission(url), hasOriginPermission(new URL(finalUrl))]);
        if (!originOk || !finalOk) return PERMISSION_DENIED;
        const response: PreviewResponse = { ok: true, data: parseMetadata(html, finalUrl), frame };
        // A detached entry (cancelled or evicted) may not write to the cache.
        if (pending.get(url.href) === entry) writeCache(url.href, response, [...entry.targets]);
        return response;
      } catch (error) {
        const response = failureResponse(error);
        if (!response.ok && !transientFailures.has(response.code) && await hasOriginPermission(url)
          && pending.get(url.href) === entry) {
          writeCache(url.href, response, [...entry.targets]);
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
      // Register the full redirect chain before the first await after the
      // response. Permission events arrive as macrotasks, so no revocation can
      // interleave before this registration, and any later one settles us.
      const destinations = waiterDestinations.get(waiterKey);
      if (destinations) for (const target of entry.targets) destinations.add(target);
      // Both grants are re-verified immediately before delivery.
      const finalUrl = response.ok && response.data.url !== url.href ? new URL(response.data.url) : null;
      const finalPermission = finalUrl ? hasOriginPermission(finalUrl) : Promise.resolve(true);
      const [sourceOk, destinationOk, finalOk] = await Promise.all([hasOriginPermission(source), hasOriginPermission(url), finalPermission]);
      const late = settledResponse(waiterKey);
      if (late) return late;
      if (!sourceOk) return SOURCE_DENIED;
      if (!destinationOk || !finalOk) return PERMISSION_DENIED;
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
    if (destination) waiterDestinations.set(waiterKey, new Set([destination.href]));
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
  void ensureCacheRestored();
  schedulePreviewRegistration();
  chrome.permissions.onAdded.addListener(() => {
    invalidateOriginGrants();
    schedulePreviewRegistration();
  });
  chrome.permissions.onRemoved.addListener(permissions => {
    // Invalidate first: a still-running query that resolves later must not be
    // treated as current, and nothing below may answer from stale grants.
    invalidateOriginGrants();
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
    if ((message.type !== 'PEEKLINK_PREVIEW' && message.type !== 'PEEKLINK_PREFETCH') || !sender.tab?.id) return false;
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
