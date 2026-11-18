import type { FramePolicy } from './types';

export function getFramePolicy(headers: Pick<Headers, 'get'>): FramePolicy {
  const xFrameOptions = headers.get('x-frame-options');
  if (xFrameOptions?.split(',').some(value => /^\s*(?:deny|sameorigin|allow-from)\b/i.test(value))) {
    return { embeddable: false, restriction: 'x-frame-options' };
  }

  const csp = headers.get('content-security-policy');
  if (csp) {
    const directives = csp.match(/(?:^|;)\s*frame-ancestors\s+[^;]*/gi) ?? [];
    const allowsAnyAncestor = directives.length > 0 && directives.every(directive => {
      const sources = directive.replace(/^(?:^|;)\s*frame-ancestors\s+/i, '').trim();
      return sources === '*';
    });
    if (directives.length > 0 && !allowsAnyAncestor) {
      return { embeddable: false, restriction: 'csp' };
    }
  }

  return { embeddable: true };
}
