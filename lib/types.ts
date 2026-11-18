export type PreviewMode = 'metadata' | 'webpage';
export type FrameRestriction = 'x-frame-options' | 'csp';

export interface FramePolicy {
  embeddable: boolean;
  restriction?: FrameRestriction;
}

export interface PreviewData {
  url: string;
  hostname: string;
  title: string;
  description: string;
  image?: string;
  favicon?: string;
}

export type PreviewErrorCode =
  | 'invalid-url'
  | 'permission'
  | 'blocked-host'
  | 'timeout'
  | 'redirect'
  | 'http'
  | 'not-html'
  | 'too-large'
  | 'queue-full'
  | 'network'
  | 'unavailable';

export type PreviewResponse =
  | { ok: true; data: PreviewData; frame: FramePolicy }
  | { ok: false; error: string; code: PreviewErrorCode };
