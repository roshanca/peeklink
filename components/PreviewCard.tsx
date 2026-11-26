import { useEffect, useState } from 'preact/hooks';
import type { FramePolicy, PreviewData, PreviewErrorCode, PreviewMode } from '../lib/types';

type Props = {
  data?: PreviewData;
  frame?: FramePolicy;
  mode: PreviewMode;
  loading: boolean;
  error?: string;
  errorCode?: PreviewErrorCode;
  url: string;
  onOpenSettings: () => void;
};

function PreviewCover({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (failed) return null;
  return <div className="peek-cover">
    <img src={src} alt="" loading="eager" referrerPolicy="no-referrer"
      data-loaded={loaded} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />
  </div>;
}

function MetadataBody({ data }: { data?: PreviewData }) {
  return <div className="peek-body">
    <div className="peek-copy">
      <div className="peek-title">{data?.title}</div>
      {data?.description && <p className="peek-description">{data.description}</p>}
    </div>
    {data?.image && <PreviewCover key={data.image} src={data.image} />}
  </div>;
}

function WebpageFrame({ url, hostname, onFailure }: { url: string; hostname: string; onFailure: () => void }) {
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    const timeout = setTimeout(onFailure, 12_000);
    return () => clearTimeout(timeout);
  }, [loaded, onFailure]);

  return <div className="peek-frame-wrap">
    {!loaded && <div className="peek-frame-loading" role="status">Loading interactive preview…</div>}
    <iframe
      key={url}
      className="peek-frame"
      src={url}
      title={`Interactive preview of ${hostname}`}
      credentialless
      sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox"
      referrerPolicy="no-referrer"
      onLoad={() => setLoaded(true)}
      onError={onFailure}
    />
  </div>;
}

export function PreviewCard({ data, frame, mode, loading, error, errorCode, url, onOpenSettings }: Props) {
  const hostname = (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })();
  const [faviconFailed, setFaviconFailed] = useState(false);
  const [forceMetadata, setForceMetadata] = useState(false);
  const [frameFailed, setFrameFailed] = useState(false);

  useEffect(() => { setFaviconFailed(false); }, [data?.favicon]);
  useEffect(() => {
    setForceMetadata(false);
    setFrameFailed(false);
  }, [url]);

  const showWebpage = mode === 'webpage' && !loading && !error && Boolean(data)
    && Boolean(frame?.embeddable) && !forceMetadata && !frameFailed;
  const frameBlocked = mode === 'webpage' && !loading && !error && Boolean(frame && !frame.embeddable);
  const canToggleWebpage = mode === 'webpage' && !loading && !error && Boolean(frame?.embeddable);
  const fallbackMessage = frameFailed
    ? 'The interactive preview could not be loaded. Showing metadata instead.'
    : frame?.restriction === 'x-frame-options'
      ? 'This website disables embedding with X-Frame-Options. Showing metadata instead.'
      : 'This website’s Content Security Policy disables embedding. Showing metadata instead.';

  return <div
    className={`peek-card ${showWebpage ? 'peek-card-webpage' : ''}`}
    role={showWebpage ? 'dialog' : 'status'}
    aria-label={showWebpage ? `Interactive preview of ${hostname}` : undefined}
    aria-live={showWebpage ? 'off' : 'polite'}
    aria-busy={loading}
  >
    <div className="peek-head">
      {data?.favicon && !faviconFailed
        ? <img className="peek-icon" src={data.favicon} alt="" referrerPolicy="no-referrer" onError={() => setFaviconFailed(true)} />
        : <span className="peek-icon peek-fallback">↗</span>}
      <span className="peek-domain">{data?.hostname ?? hostname}</span>
      {canToggleWebpage && <button
        className="peek-mode"
        type="button"
        onClick={() => {
          if (showWebpage) setForceMetadata(true);
          else {
            setFrameFailed(false);
            setForceMetadata(false);
          }
        }}
      >{showWebpage ? 'Metadata' : 'Webpage'}</button>}
      <a className="peek-open" href={url} target="_blank" rel="noopener noreferrer" aria-label="Open link in new tab" title="Open in new tab">↗</a>
    </div>
    {loading ? <div className="peek-skeleton" aria-hidden="true"><span /><span /><span /></div> : error ?
      <div className="peek-error">
        <div className="peek-title">Preview unavailable</div>
        <p className="peek-description">{error}</p>
        {errorCode === 'permission' && <button className="peek-settings" type="button" onClick={onOpenSettings}>Open PeekLink settings</button>}
      </div> : showWebpage && data ?
      <WebpageFrame url={data.url} hostname={hostname} onFailure={() => setFrameFailed(true)} /> :
      <>
        {(frameBlocked || frameFailed) && <p className="peek-frame-notice">{fallbackMessage}</p>}
        <MetadataBody data={data} />
      </>}
  </div>;
}
