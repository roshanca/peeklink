import { defineBackground } from '#imports';
import { parseMetadata } from '../lib/metadata';
import type { PreviewData, PreviewResponse } from '../lib/types';

const cache = new Map<string, { data: PreviewData; expires: number }>();
const TTL = 15 * 60 * 1000;

async function getPreview(rawUrl: string): Promise<PreviewResponse> {
  try {
    const url = new URL(rawUrl);
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: 'Unsupported URL' };
    if (url.username || url.password) return { ok: false, error: 'Credential URLs are not supported' };
    const key = url.href;
    const hit = cache.get(key);
    if (hit && hit.expires > Date.now()) return { ok: true, data: hit.data };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(key, {
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!(response.headers.get('content-type') ?? '').includes('text/html')) throw new Error('Not an HTML page');
      // Cap the parsed response; a streaming cap can be added in a later release.
      const html = (await response.text()).slice(0, 400_000);
      const data = parseMetadata(html, response.url || key);
      cache.set(key, { data, expires: Date.now() + TTL });
      if (cache.size > 250) cache.delete(cache.keys().next().value!);
      return { ok: true, data };
    } finally { clearTimeout(timeout); }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Preview unavailable' };
  }
}

export function resolveImageUrl(
  imageUrl: string | undefined,
  pageUrl: string,
): string | undefined {
  if (!imageUrl) return undefined;

  try {
    const url = new URL(imageUrl, pageUrl);

    if (!['https:', 'http:'].includes(url.protocol)) {
      return undefined;
    }

    return url.href;
  } catch {
    return undefined;
  }
}

export default defineBackground(() => {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse: (response: PreviewResponse) => void) => {
    if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'PEEKLINK_PREVIEW') return false;
    const url = 'url' in message ? message.url : undefined;
    if (typeof url !== 'string') return false;
    void getPreview(url).then(sendResponse);
    return true;
  });
});
