import type { PreviewData } from '../lib/types';

type Props = { data?: PreviewData; loading: boolean; error?: string; url: string };
export function PreviewCard({ data, loading, error, url }: Props) {
  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
  return <div className="peek-card" role="status" aria-live="polite">
    <div className="peek-head">
      {data?.favicon ? <img className="peek-icon" src={data.favicon} alt="" /> : <span className="peek-icon peek-fallback">↗</span>}
      <span className="peek-domain">{data?.hostname ?? hostname}</span>
      <a className="peek-open" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open link in new tab" title="Open in new tab">↗</a>
    </div>
    {loading ? <div className="peek-skeleton"><span /><span /><span /></div> : error ?
      <><div className="peek-title">Preview unavailable</div><p className="peek-description">{error}</p></> :
      <div className="peek-body">
        <div className="peek-copy"><div className="peek-title">{data?.title}</div>{data?.description && <p className="peek-description">{data.description}</p>}</div>
        {data?.image && <img className="peek-cover" src={data.image} alt="" />}
      </div>}
  </div>;
}
