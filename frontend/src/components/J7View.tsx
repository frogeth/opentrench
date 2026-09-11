import { useEffect, useMemo, useRef, useState } from 'react';
import type { J7Deploy, J7Tweet, TokenInfo } from '../types';
import { api } from '../api';
import { money, timeAgo } from '../format';
import { Avatar } from './Avatar';
import { RichText } from './RichText';
import { Icon } from './Icon';
import { VirtualItem } from './Virtual';

const fmtFollowers = (n?: number) => (n === undefined ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));

/** Which calls a tweet is talking about: by contract address, or by $TICKER against tokens called in the last day. */
export function matchesFor(t: J7Tweet, tokens: Record<string, TokenInfo>, now: number): TokenInfo[] {
  const out = new Map<string, TokenInfo>();
  for (const c of t.contracts) {
    const k = tokens[c.address] ? c.address : tokens[c.address.toLowerCase()] ? c.address.toLowerCase() : null;
    if (k) out.set(k, tokens[k]);
  }
  if (t.tickers.length) {
    const recent = Object.values(tokens).filter((x) => x.symbol && now - x.lastCallTs < 24 * 3600e3);
    for (const sym of t.tickers) {
      for (const x of recent) if (x.symbol!.toUpperCase() === sym && !out.has(x.address)) out.set(x.address, x);
    }
  }
  return [...out.values()];
}

type DeployState = { loading: boolean; error?: string; deploys?: J7Deploy[]; scanned?: { pump?: number; pons?: number } };


function DeployRow({ x, now }: { x: J7Deploy; now: number }) {
  return (
    <div className="deploy">
      {x.image ? <img src={x.image} alt="" /> : <span className="deploy-noimg" />}
      <span className="deploy-main">
        <span className="deploy-name">
          <b>{x.symbol || x.name}</b> <span className="muted">{x.name}</span>
          <span className={`deploy-src ${x.source}`}>{x.source === 'pump' ? 'pump.fun' : 'pons'}</span>
        </span>
        <span className="deploy-meta muted">
          launched {timeAgo(x.createdAt, now)} ago{money(x.marketCap) ? ` · MC ${money(x.marketCap)}` : ''} ·{' '}
          <a href={x.url} target="_blank" rel="noreferrer">
            open
          </a>
        </span>
        <span className="deploy-ca">
          <RichText text={x.mint} contracts={[x.mint]} />
        </span>
      </span>
    </div>
  );
}

/** On-demand scan results: older launches linking this tweet. */
function Deploys({ t, now, state }: { t: J7Tweet; now: number; state: DeployState }) {
  if (state.loading) return <div className="tweet-deploys muted">scanning pump.fun and Pons for older launches linking this tweet…</div>;
  if (state.error) return <div className="tweet-deploys err">{state.error}</div>;
  const d = state.deploys ?? [];
  const back = [state.scanned?.pump, state.scanned?.pons].filter((x): x is number => typeof x === 'number');
  const oldest = back.length ? Math.max(...back) : undefined;
  const partial = oldest !== undefined && oldest > t.ts;
  const down = [state.scanned?.pump === undefined ? 'pump.fun' : null, state.scanned?.pons === undefined ? 'Pons' : null].filter(Boolean);
  return (
    <div className="tweet-deploys">
      {d.length === 0 && (
        <div className="muted">
          no launches link this tweet{partial ? ` in the last ${timeAgo(oldest, now)} of launches (older ones weren't scanned)` : ''}
          {down.length ? ` · ${down.join(' and ')} unreachable` : ''}
        </div>
      )}
      {d.map((x) => (
        <DeployRow key={x.mint} x={x} now={now} />
      ))}
      {d.length > 0 && partial && <div className="muted">scanned the last {timeAgo(oldest, now)} of launches; older ones weren't checked</div>}
    </div>
  );
}

/** The J7Tracker feed, native: tweets newest first with the calls they touch. */
export function J7View({
  tweets,
  tokens,
  now,
  connected,
  error,
  hasToken,
  favorites,
  onFavorite,
  onLoaded,
  onSelect,
}: {
  tweets: J7Tweet[];
  tokens: Record<string, TokenInfo>;
  now: number;
  connected: boolean;
  error?: string;
  hasToken: boolean;
  /** X handles (lower-case) whose tweets ping you */
  favorites: string[];
  onFavorite: (handle: string) => void;
  onLoaded: (t: J7Tweet[]) => void;
  /** highlight a call in the Calls column */
  onSelect: (address: string) => void;
}) {
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [deploys, setDeploys] = useState<Record<string, DeployState>>({});
  // "latest" button: the column scrolls (newest on top); count tweets that land while scrolled away
  const rootRef = useRef<HTMLDivElement>(null);
  const atTopRef = useRef(true);
  const [atTop, setAtTop] = useState(true);
  const [pending, setPending] = useState(0);
  const seenIds = useRef<Set<string> | null>(null);
  useEffect(() => {
    const scroller = rootRef.current?.closest('.col-body') as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      const top = scroller.scrollTop < 40;
      atTopRef.current = top;
      setAtTop(top);
      if (top) setPending(0);
    };
    onScroll();
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => scroller.removeEventListener('scroll', onScroll);
  }, [hasToken]);
  useEffect(() => {
    if (seenIds.current === null) {
      seenIds.current = new Set(tweets.map((t) => t.id));
      return;
    }
    let fresh = 0;
    for (const t of tweets) {
      if (seenIds.current.has(t.id)) continue;
      seenIds.current.add(t.id);
      fresh++;
    }
    if (fresh && !atTopRef.current) setPending((n) => n + fresh);
  }, [tweets]);
  const toLatest = () => {
    const scroller = rootRef.current?.closest('.col-body') as HTMLElement | null;
    if (!scroller) return;
    const go = () => (scroller.scrollTop = 0);
    go();
    window.setTimeout(go, 120);
    window.setTimeout(go, 400);
    setPending(0);
  };
  useEffect(() => {
    if (!hasToken) return;
    api.j7Recent().then((r) => onLoaded(Array.isArray(r) ? r : [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);
  const favs = useMemo(() => new Set(favorites.map((h) => h.toLowerCase())), [favorites]);
  const rows = useMemo(() => tweets.map((t) => ({ t, m: matchesFor(t, tokens, now) })).filter((r) => !onlyMatches || r.m.length > 0), [tweets, tokens, now, onlyMatches]);

  const findDeploys = (t: J7Tweet) => {
    const key = t.id;
    if (deploys[key] && !deploys[key].error) {
      // second click hides it again
      setDeploys((d) => {
        const { [key]: _gone, ...rest } = d;
        return rest;
      });
      return;
    }
    setDeploys((d) => ({ ...d, [key]: { loading: true } }));
    const tweetId = t.id.replace(/^deleted:/, '');
    api
      .j7Deploys(tweetId, t.author.handle, t.ts)
      .then((r) => setDeploys((d) => ({ ...d, [key]: { loading: false, deploys: r.deploys, scanned: r.scanned } })))
      .catch((e) => setDeploys((d) => ({ ...d, [key]: { loading: false, error: e?.message ?? String(e) } })));
  };

  if (!hasToken) return <div className="empty">Paste your J7Tracker session id in ⚙ → Accounts → J7Tracker to stream its feed here.</div>;
  return (
    <div className="j7" ref={rootRef}>
      {!atTop && (
        <button className="jump jump-top" onClick={toLatest}>
          ↑ {pending > 0 ? `${pending} new` : 'latest'}
        </button>
      )}
      <div className="j7-bar">
        <span className={`j7-dot${connected ? ' on' : ''}`} /> {connected ? 'live' : error ?? 'connecting…'}
        <span className="j7-toggles">
          <button className={`hdr-toggle${onlyMatches ? ' on' : ''}`} onClick={() => setOnlyMatches((v) => !v)} title="only tweets that mention a contract or $ticker that's in your Calls column">
            calls only
          </button>
        </span>
      </div>
      {rows.length === 0 && <div className="empty">{onlyMatches ? 'No tweets touching your calls yet.' : 'Waiting for tweets…'}</div>}
      {rows.map(({ t, m }) => {
        const fav = favs.has(t.author.handle.toLowerCase());
        const dep = deploys[t.id];
        return (
          <VirtualItem key={t.id} id={`j7:${t.id}`} domKey={t.id} estimate={t.images.length ? 220 : 96}>
            <div className={`tweet${m.length ? ' tweet-hit' : ''}${t.deleted ? ' tweet-deleted' : ''}`}>
              <div className="tweet-head">
                <Avatar src={t.author.avatar} name={t.author.name} size={28} crown={fav} />
                <span className="tweet-who">
                  <b>{t.author.name}</b>
                  <span className="muted">
                    @{t.author.handle}
                    {t.author.followers !== undefined && ` · ${fmtFollowers(t.author.followers)}`}
                  </span>
                </span>
                <button className={`tweet-fav${fav ? ' on' : ''}`} onClick={() => onFavorite(t.author.handle)} title={fav ? `stop pinging when @${t.author.handle} tweets` : `ping me when @${t.author.handle} tweets`}>
                  {fav ? '★' : '☆'}
                </button>
                {t.deleted && (
                  <span className="tweet-del" title={`posted ${timeAgo(t.ts, now)} ago, deleted ${timeAgo(t.deleted, now)} ago`}>
                    <Icon name="trash" size={10} /> deleted {timeAgo(t.deleted, now)}
                  </span>
                )}
                <a className="tweet-time" href={t.url} target="_blank" rel="noreferrer" title="open on X">
                  {timeAgo(t.ts, now)} <Icon name="x" size={10} />
                </a>
              </div>
              {t.replyTo && <div className="tweet-reply muted">replying to @{t.replyTo}</div>}
              <div className="tweet-text">
                <RichText text={t.text} contracts={t.contracts.map((c) => c.address)} />
              </div>
              {t.quoted && (
                <div className="tweet-quote">
                  <b>@{t.quoted.handle}</b> {t.quoted.text.slice(0, 280)}
                </div>
              )}
              {t.images.length > 0 && (
                <div className={`tweet-media n${Math.min(t.images.length, 4)}`}>
                  {t.images.slice(0, 4).map((src) => (
                    <img key={src} src={src} alt="" loading="lazy" />
                  ))}
                </div>
              )}
              {t.launches && t.launches.length > 0 && (
                <div className="tweet-deploys tweet-deploys-live">
                  <div className="deploy-live-title">
                    <span className="j7-dot on" /> launched off this tweet
                  </div>
                  {t.launches.map((x) => (
                    <DeployRow key={x.mint} x={x} now={now} />
                  ))}
                </div>
              )}
              {m.length > 0 && (
                <div className="tweet-matches">
                  {m.map((x) => (
                    <button key={x.address} className="tweet-match" onClick={() => onSelect(x.address)} title="show this call">
                      {x.imageUrl ? <img src={x.imageUrl} alt="" /> : null}
                      <b>{x.symbol ?? x.address.slice(0, 6)}</b>
                      {money(x.marketCap) && <span>MC {money(x.marketCap)}</span>}
                      <span className="muted">{x.seen}× called</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="tweet-actions">
                <button className={`hdr-toggle${dep && !dep.error ? ' on' : ''}`} onClick={() => findDeploys(t)} title="new launches pair up on their own while this column is open; this scans pump.fun and Pons for older tokens whose links point at this exact tweet">
                  <Icon name="search" size={10} /> {t.launches?.length ? 'scan for more' : 'scan launches'}
                </button>
              </div>
              {dep && <Deploys t={t} now={now} state={dep} />}
            </div>
          </VirtualItem>
        );
      })}
    </div>
  );
}
