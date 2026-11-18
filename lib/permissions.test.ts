import { describe, expect, it } from 'vitest';
import { urlOriginPattern, websiteOriginPattern } from './permissions';

describe('website permissions', () => {
  it('creates Chrome match patterns from hostnames and URLs', () => {
    expect(websiteOriginPattern('example.com')).toBe('https://example.com/*');
    expect(websiteOriginPattern('http://localhost:3000/docs')).toBe('http://localhost/*');
    expect(urlOriginPattern(new URL('https://example.com:8443/path'))).toBe('https://example.com/*');
  });

  it('rejects invalid and unsupported inputs', () => {
    expect(websiteOriginPattern('')).toBeNull();
    expect(websiteOriginPattern('file:///tmp/page.html')).toBeNull();
    expect(websiteOriginPattern('not a valid hostname')).toBeNull();
  });
});
