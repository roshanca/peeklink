import { useEffect, useState } from 'react';
import type { PreviewData } from '../lib/types';

type Props = { data?: PreviewData; loading: boolean; error?: string; url: string };

function PreviewCover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [src]);
  if (failed) return null;
  return <img className="peek-cover" src={src} alt="" loading="eager" referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
}

export function PreviewCard({ data, loading, error, url }: Props) {
  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
  const [faviconFailed, setFaviconFailed] = useState(false);
  useEffect(() => { setFaviconFailed(false); }, [data?.favicon]);
  return <div className="peek-card" role="status" aria-live="polite">
    <div className="peek-head">
      {data?.favicon && !faviconFailed
        ? <img className="peek-icon" src={data.favicon} alt="" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
        : <span className="peek-icon peek-fallback">↗</span>}
      <span className="peek-domain">{data?.hostname ?? hostname}</span>
      <a className="peek-open" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open link in new tab" title="Open in new tab">↗</a>
    </div>
    {loading ? <div className="peek-skeleton"><span /><span /><span /></div> : error ?
      <><div className="peek-title">Preview unavailable</div><p className="peek-description">{error}</p></> :
      <div className="peek-body">
        <div className="peek-copy"><div className="peek-title">{data?.title}</div>{data?.description && <p className="peek-description">{data.description}</p>}</div>
        {data?.image && <PreviewCover key={data.image} src={data.image} />}
      </div>}
  </div>;
}
