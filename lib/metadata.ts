import { decodeHTMLAttribute, decodeHTMLStrict } from 'entities';
import type { PreviewData } from './types';

function attrs(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1];
    if (name) result[name.toLowerCase()] = decodeHTMLAttribute(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return result;
}

function absolute(value: string | undefined, base: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value, base);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined;
  } catch { return undefined; }
}

export function parseMetadata(html: string, url: string): PreviewData {
  const parsed = new URL(url);
  const meta = new Map<string, string>();
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = attrs(tag);
    const key = (a.property ?? a.name ?? '').toLowerCase();
    if (key && a.content && !meta.has(key)) meta.set(key, a.content);
  }
  const titleTag = html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? '';
  const iconTag = (html.match(/<link\b[^>]*>/gi) ?? []).map(attrs)
    .find(a => /(?:^|\s)(?:icon|shortcut icon)(?:\s|$)/i.test(a.rel ?? ''));
  const strip = (s: string) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  // Meta attribute values are already entity-decoded by attrs(); the title tag is raw text.
  const plain = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    url,
    hostname: parsed.hostname.replace(/^www\./, ''),
    title: plain(meta.get('og:title') ?? meta.get('twitter:title') ?? decodeHTMLStrict(strip(titleTag))) || parsed.hostname,
    description: plain(meta.get('og:description') ?? meta.get('twitter:description') ?? meta.get('description') ?? ''),
    image: absolute(meta.get('og:image') ?? meta.get('twitter:image'), url),
    favicon: absolute(iconTag?.href, url) ?? `${parsed.origin}/favicon.ico`,
  };
}
