export function websiteOriginPattern(value: string): string | null {
  const input = value.trim();
  if (!input) return null;

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return null;
  }
}

export function urlOriginPattern(url: URL): string {
  return `${url.protocol}//${url.hostname}/*`;
}
