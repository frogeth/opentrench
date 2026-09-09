import { useState } from 'react';
import { api, type SitePreview, type XProfile } from '../api';
import { HoverCard } from './HoverCard';
import { Icon } from './Icon';

function compact(n?: number): string {
  if (n === undefined) return '–';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** Website link whose hover shows the site's Open Graph card. */
export function SiteLink({ url, children }: { url: string; children: React.ReactNode }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [p, setP] = useState<SitePreview | null>(null);
  const load = () => {
    setState('loading');
    api
      .sitePreview(url)
      .then((r) => setP(r))
      .catch(() => setP(null))
      .finally(() => setState('done'));
  };
  let domain = url;
  try {
    domain = new URL(url).hostname.replace(/^www\./, '');
  } catch {}
  const card =
    state !== 'done' ? (
      <div className="hc-site hc-loading">
        <span className="hc-domain">{domain}</span> loading preview…
      </div>
    ) : p ? (
      <div className="hc-site">
        {p.image && <img className="hc-site-img" src={p.image} alt="" loading="lazy" onError={(e) => ((e.target as HTMLImageElement).hidden = true)} />}
        <div className="hc-site-body">
          <div className="hc-domain">
            <Icon name="globe" size={11} /> {p.domain}
          </div>
          {p.title && <div className="hc-title">{p.title}</div>}
          {p.description && <div className="hc-desc">{p.description}</div>}
          <a className="hc-btn" href={url} target="_blank" rel="noreferrer">
            Visit website
          </a>
        </div>
      </div>
    ) : (
      <div className="hc-site hc-loading">
        <span className="hc-domain">{domain}</span> no preview available
      </div>
    );
  return (
    <HoverCard card={card} width={300} onOpen={load}>
      {children}
    </HoverCard>
  );
}

/** X link whose hover shows the profile card (name, bio, joined, followers). */
export function XLink({ handle, children }: { handle: string; children: React.ReactNode }) {
  const [state, setState] = useState<'idle' | 'loading' | 'done'>('idle');
  const [p, setP] = useState<XProfile | null>(null);
  const load = () => {
    setState('loading');
    api
      .xProfile(handle)
      .then((r) => setP(r))
      .catch(() => setP(null))
      .finally(() => setState('done'));
  };
  const card =
    state !== 'done' ? (
      <div className="hc-x hc-loading">@{handle} · loading profile…</div>
    ) : p ? (
      <div className="hc-x">
        <div className="hc-x-banner" style={p.banner ? { backgroundImage: `url(${p.banner})` } : undefined} />
        <div className="hc-x-body">
          <div className="hc-x-head">
            {p.avatar ? <img className="hc-x-avatar" src={p.avatar} alt="" /> : <span className="hc-x-avatar" />}
            <Icon name="x" size={16} />
          </div>
          <div className="hc-x-name">
            {p.name} {p.verified && <span className="hc-verified" title="verified">✓</span>}
          </div>
          <div className="hc-x-handle">@{p.handle}</div>
          {p.bio && <div className="hc-x-bio">{p.bio}</div>}
          <div className="hc-x-meta">
            {p.location && <span>📍 {p.location}</span>}
            {p.joined && <span>📅 Joined {new Date(p.joined).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</span>}
          </div>
          <div className="hc-x-counts">
            <span>
              <b>{compact(p.following)}</b> Following
            </span>
            <span>
              <b>{compact(p.followers)}</b> Followers
            </span>
          </div>
          <a className="hc-btn" href={p.url} target="_blank" rel="noreferrer">
            See profile on X
          </a>
        </div>
      </div>
    ) : (
      <div className="hc-x hc-loading">@{handle} · profile unavailable</div>
    );
  return (
    <HoverCard card={card} width={280} onOpen={load}>
      {children}
    </HoverCard>
  );
}
