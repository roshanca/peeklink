import { describe, expect, it } from 'vitest';
import { getFramePolicy } from './frame-policy';

function headers(xFrameOptions: string | null, csp: string | null) {
  return {
    get(name: string) {
      if (name === 'x-frame-options') return xFrameOptions;
      if (name === 'content-security-policy') return csp;
      return null;
    },
  };
}

describe('getFramePolicy', () => {
  it('allows framing when no restriction is present', () => {
    expect(getFramePolicy(headers(null, null))).toEqual({ embeddable: true });
    expect(getFramePolicy(headers(null, 'frame-ancestors *'))).toEqual({ embeddable: true });
  });

  it('detects X-Frame-Options restrictions', () => {
    expect(getFramePolicy(headers('DENY', null))).toEqual({ embeddable: false, restriction: 'x-frame-options' });
    expect(getFramePolicy(headers('SAMEORIGIN', null)).embeddable).toBe(false);
  });

  it('conservatively rejects restricted CSP frame ancestors', () => {
    expect(getFramePolicy(headers(null, "default-src 'self'; frame-ancestors 'none'"))).toEqual({ embeddable: false, restriction: 'csp' });
    expect(getFramePolicy(headers(null, "frame-ancestors 'self' https://trusted.example")).embeddable).toBe(false);
  });
});
