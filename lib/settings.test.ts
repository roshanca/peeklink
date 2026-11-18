import { describe, expect, it } from 'vitest';
import { matchesTargetRule, parseTargetRules } from './preview-target';
import {
  DEFAULT_SETTINGS,
  isWebsiteAllowed,
  normalizeSettings,
  parseWebsiteRules,
} from './settings';

describe('settings', () => {
  it('keeps safe defaults and clamps trigger delay', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ delay: -100 }).delay).toBe(0);
    expect(normalizeSettings({ delay: 9000 }).delay).toBe(3000);
    expect(normalizeSettings({ mode: 'webpage' }).mode).toBe('webpage');
    expect(normalizeSettings({ mode: 'invalid' }).mode).toBe('metadata');
  });

  it('normalizes and deduplicates website rules', () => {
    expect(parseWebsiteRules('Example.com\n*.example.org,example.com')).toEqual(['example.com', 'example.org']);
    expect(() => parseWebsiteRules('not a valid hostname')).toThrow('Invalid website rule');
  });

  it('matches subdomains and gives the blocklist precedence', () => {
    const settings = { ...DEFAULT_SETTINGS, allowlist: ['example.com'] };
    expect(isWebsiteAllowed('https://docs.example.com/page', settings)).toBe(true);
    expect(isWebsiteAllowed('https://unrelated.example/page', settings)).toBe(false);
    expect(isWebsiteAllowed('https://docs.example.com/page', {
      ...settings,
      blocklist: ['docs.example.com'],
    })).toBe(false);
  });

  it('matches excluded destinations at hostname and path boundaries', () => {
    const rules = parseTargetRules('https://EXAMPLE.com/subscribe?source=nav\nexample.com/media/*');
    expect(normalizeSettings({ excludedTargets: rules }).excludedTargets).toEqual(['example.com/subscribe', 'example.com/media/*']);
    const excluded = (url: string) => rules.some(rule => matchesTargetRule(new URL(url), rule));
    expect(excluded('http://sub.example.com/subscribe?plan=annual')).toBe(true);
    expect(excluded('https://example.com/subscribe/help')).toBe(false);
    expect(excluded('https://example.com/media/123')).toBe(true);
    expect(excluded('https://notexample.com/media/123')).toBe(false);
    expect(excluded('https://example.com/mediakit/123')).toBe(false);
    expect(() => parseTargetRules('example.com/me*dia')).toThrow('Invalid destination rule');
  });
});
