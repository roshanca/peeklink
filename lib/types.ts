export interface PreviewData {
  url: string;
  hostname: string;
  title: string;
  description: string;
  image?: string;
  favicon?: string;
}
export type PreviewResponse = { ok: true; data: PreviewData } | { ok: false; error: string };
