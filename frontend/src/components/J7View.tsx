import { useEffect, useMemo, useState } from 'react';
import type { J7Tweet, TokenInfo } from '../types';
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

/** The J7Tracker feed, native: tweets newest first with the calls they touch. */
export function J7View({
  tweets,
  tokens,
  now,
  connected,
  error,
  hasToken,
  onLoaded,
  onSelect,
}: {
  tweets: J7Tweet[];
  tokens: Record<string, TokenInfo>;
  now: number;
  connected: boolean;
  error?: string;
  hasToken: boolean;
  onLoaded: (t: J7Tweet[]) => void;
  /** highlight a call in the Calls column */
  onSelect: (address: string) => void;
}) {
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [onlyDeleted, setOnlyDeleted] = useState(false);
  useEffect(() => {
    if (!hasToken) return;
    api.j7Recent().then((r) => onLoaded(Array.isArray(r) ? r : [])).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasToken]);
  const rows = useMemo(() => tweets.map((t) => ({ t, m: matchesFor(t, tokens, now) })).filter((r) => (!onlyMatches || r.m.length > 0) && (!onlyDeleted || r.t.deleted)), [tweets, tokens, now, onlyMatches, onlyDeleted]);

  if (!hasToken) return <div className="empty">Paste your J7Tracker session id in ⚙ → Accounts → J7Tracker to stream its feed here.</div>;
  return (
    <div className="j7">
      <div className="j7-bar">
        <span className={`j7-dot${connected ? ' on' : ''}`} /> {connected ? 'live' : error ?? 'connecting…'}
        <span className="j7-toggles">
          <button className={`hdr-toggle${onlyDeleted ? ' on' : ''}`} onClick={() => setOnlyDeleted((v) => !v)} title="only tweets the author deleted">
            deleted
          </button>
          <button className={`hdr-toggle${onlyMatches ? ' on' : ''}`} onClick={() => setOnlyMatches((v) => !v)} title="only tweets that mention a token in your calls">
            matches
          </button>
        </span>
      </div>
      {rows.length === 0 && <div className="empty">{onlyDeleted ? 'No deleted tweets yet.' : onlyMatches ? 'No tweets touching your calls yet.' : 'Waiting for tweets…'}</div>}
      {rows.map(({ t, m }) => (
        <VirtualItem key={t.id} id={`j7:${t.id}`} domKey={t.id} estimate={t.images.length ? 220 : 96}>
          <div className={`tweet${m.length ? ' tweet-hit' : ''}${t.deleted ? ' tweet-deleted' : ''}`}>
            <div className="tweet-head">
              <Avatar src={t.author.avatar} name={t.author.name} size={28} />
              <span className="tweet-who">
                <b>{t.author.name}</b>
                <span className="muted">
                  @{t.author.handle}
                  {t.author.followers !== undefined && ` · ${fmtFollowers(t.author.followers)}`}
                </span>
              </span>
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
          </div>
        </VirtualItem>
      ))}
    </div>
  );
}
