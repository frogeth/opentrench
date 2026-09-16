import { useEffect, useRef, useState } from 'react';

/**
 * A provider's chart embed with the wait made visible. The frame is black until the provider answers
 * (BasedBot sits behind Cloudflare and can take a while), so a "loading" line covers it until the
 * document loads, and after `slowAfterMs` a button offers the Dexscreener embed instead when one exists.
 */
export function ChartFrame({ src, alt, title, className = 'token-chart', slowAfterMs = 10_000 }: { src: string; /** the Dexscreener/GeckoTerminal embed for the same token, offered when `src` is slow */ alt?: string; title: string; className?: string; slowAfterMs?: number }) {
  const [url, setUrl] = useState(src);
  const [loaded, setLoaded] = useState(false);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(Date.now());
  useEffect(() => {
    setUrl(src);
    setLoaded(false);
    setSlow(false);
    startedAt.current = Date.now();
  }, [src]);
  // the frame fires a load for its initial blank document right after mount; only a later one is the provider answering
  const onLoad = () => {
    if (Date.now() - startedAt.current < 300) return;
    window.setTimeout(() => setLoaded(true), 2000);
  };
  useEffect(() => {
    if (loaded) return;
    const t = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => window.clearTimeout(t);
  }, [loaded, url, slowAfterMs]);
  const canSwap = !!alt && alt !== url;
  const provider = /basedbot/.test(url) ? 'BasedBot' : /birdeye/.test(url) ? 'Birdeye' : /gmgn/.test(url) ? 'GMGN' : /geckoterminal/.test(url) ? 'GeckoTerminal' : 'Dexscreener';
  return (
    <div className="chart-frame">
      {/* the document loads well before the chart inside it paints: keep the line a moment longer */}
      <iframe className={className} src={url} title={title} allow="clipboard-write" allowFullScreen onLoad={onLoad} />
      {!loaded && (
        <div className="chart-frame-wait">
          <span>loading {provider} chart…</span>
          {slow && canSwap && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setUrl(alt!);
                setLoaded(false);
                setSlow(false);
              }}
            >
              {provider} is slow · use Dexscreener
            </button>
          )}
        </div>
      )}
    </div>
  );
}
