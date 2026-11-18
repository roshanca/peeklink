import type { PreviewMode } from './types';

export interface PeekSettings {
  mode: PreviewMode;
  requireOption: boolean;
  delay: number;
  allowlist: string[];
  blocklist: string[];
}

export const DEFAULT_SETTINGS: PeekSettings = {
  mode: 'metadata',
  requireOption: false,
  delay: 500,
  allowlist: [],
  blocklist: [],
};

const SETTINGS_KEY = 'settings';

export function normalizeWebsiteRule(value: string): string | null {
  const input = value.trim().toLowerCase();
  if (!input) return null;

  try {
    const url = new URL(input.includes('://') ? input : `https://${input}`);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) return null;
    return url.hostname.replace(/^\*\./, '').replace(/\.$/, '');
  } catch {
    return null;
  }
}

export function parseWebsiteRules(value: string): string[] {
  const rules: string[] = [];
  for (const item of value.split(/[\n,]/)) {
    if (!item.trim()) continue;
    const rule = normalizeWebsiteRule(item);
    if (!rule) throw new Error(`Invalid website rule: ${item.trim()}`);
    if (!rules.includes(rule)) rules.push(rule);
  }
  return rules;
}

function websiteMatches(hostname: string, rule: string): boolean {
  return hostname === rule || hostname.endsWith(`.${rule}`);
}

export function isWebsiteAllowed(pageUrl: string, settings: PeekSettings): boolean {
  try {
    const hostname = new URL(pageUrl).hostname.toLowerCase().replace(/\.$/, '');
    if (settings.blocklist.some(rule => websiteMatches(hostname, rule))) return false;
    return settings.allowlist.length === 0
      || settings.allowlist.some(rule => websiteMatches(hostname, rule));
  } catch {
    return false;
  }
}

export function normalizeSettings(value: unknown): PeekSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SETTINGS };
  const candidate = value as Partial<PeekSettings>;
  const cleanRules = (rules: unknown): string[] => Array.isArray(rules)
    ? [...new Set(rules.filter((rule): rule is string => typeof rule === 'string')
      .map(normalizeWebsiteRule)
      .filter((rule): rule is string => Boolean(rule)))]
    : [];

  return {
    mode: candidate.mode === 'webpage' || candidate.mode === 'metadata'
      ? candidate.mode
      : DEFAULT_SETTINGS.mode,
    requireOption: typeof candidate.requireOption === 'boolean'
      ? candidate.requireOption
      : DEFAULT_SETTINGS.requireOption,
    delay: typeof candidate.delay === 'number' && Number.isFinite(candidate.delay)
      ? Math.min(3000, Math.max(0, Math.round(candidate.delay)))
      : DEFAULT_SETTINGS.delay,
    allowlist: cleanRules(candidate.allowlist),
    blocklist: cleanRules(candidate.blocklist),
  };
}

export async function getSettings(): Promise<PeekSettings> {
  const result = await chrome.storage.sync.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: PeekSettings): Promise<void> {
  await chrome.storage.sync.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}
