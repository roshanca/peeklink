export const previewMediaSelector = 'img, picture, video, [role~="img"]';
const imagePath = /\.(?:avif|bmp|gif|heic|heif|ico|jpe?g|jxl|png|svgz?|tiff?|webp)$/i;
const controlSelector = 'button, [role~="button"], [aria-haspopup]:not([aria-haspopup="false"]):not([aria-haspopup=""])';

function looksLikeButton(style: CSSStyleDeclaration): boolean {
  const filled = style.backgroundColor !== 'transparent' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
  const outlined = style.borderTopStyle !== 'none' && parseFloat(style.borderTopWidth) > 0;
  const padded = parseFloat(style.paddingLeft) >= 8 && parseFloat(style.paddingRight) >= 8;
  return (filled || outlined) && padded && parseFloat(style.borderTopLeftRadius) >= 4;
}

export function normalizeTargetRule(value: string): string | null {
  const input = value.trim();
  if (!input || /\s/.test(input)) return null;
  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    const path = url.pathname === '/' ? '' : url.pathname;
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || url.hostname.includes('*') || path.replace(/\/\*$/, '').includes('*')) return null;
    return url.hostname.replace(/\.$/, '') + path;
  } catch {
    return null;
  }
}

export function parseTargetRules(value: string): string[] {
  const rules = new Set<string>();
  for (const line of value.split('\n')) {
    if (!line.trim()) continue;
    const rule = normalizeTargetRule(line);
    if (!rule) throw new Error(`Invalid destination rule: ${line.trim()}`);
    rules.add(rule);
  }
  return [...rules];
}

export function matchesTargetRule(url: URL, rule: string): boolean {
  const slash = rule.indexOf('/');
  const hostname = slash === -1 ? rule : rule.slice(0, slash);
  const host = url.hostname.replace(/\.$/, '');
  if (host !== hostname && !host.endsWith(`.${hostname}`)) return false;
  if (slash === -1) return true;
  const path = rule.slice(slash);
  return path.endsWith('/*') ? url.pathname.startsWith(path.slice(0, -1)) : url.pathname === path;
}

export function canPreviewTarget(link: HTMLAnchorElement, excludedTargets: string[]): boolean {
  if (link.closest(controlSelector)) return false;
  // Empty or fragment-only hrefs resolve to the current page — they are script
  // hooks, not destinations, and previewing them would fetch the page itself.
  const rawHref = link.getAttribute('href')?.trim() ?? '';
  if (!rawHref || rawHref.startsWith('#')) return false;
  let url: URL;
  try { url = new URL(link.href); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || imagePath.test(url.pathname)) return false;
  if (excludedTargets.some(rule => matchesTargetRule(url, rule))) return false;

  const style = getComputedStyle(link);
  if (looksLikeButton(style)) return false;
  const hasMedia = link.querySelector(previewMediaSelector) || style.backgroundImage.includes('url(');
  return !hasMedia || Boolean(link.innerText.trim());
}
