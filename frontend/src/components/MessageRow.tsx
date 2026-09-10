import { useState } from 'react';
import type { FeedMessage, LinkPreview, MediaItem, TokenInfo } from '../types';
import { fmtTime, isFavorite } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { TokenChip } from './TokenChip';
import { Icon } from './Icon';
import { AuthorMenu } from './AuthorMenu';
import { RichText } from './RichText';
import { Embed } from './Embed';

const isVideoFile = (url: string, mime?: string) => (mime ? mime.startsWith('video/') : /\.(mp4|webm|mov)(\?|$)/i.test(url));

function Media({ item }: { item: MediaItem }) {
  // Anything that fails to load (expired CDN link, unsupported format) disappears instead of leaving a box.
  const [broken, setBroken] = useState(false);
  if (broken) return null;
  const fail = () => setBroken(true);
  if (item.kind === 'video') {
    return (
      <video className="media-video" src={item.url} poster={item.poster} controls preload="metadata" playsInline onError={fail} />
    );
  }
  if (item.kind === 'gif' && isVideoFile(item.url, item.mime)) {
    return <video className="media-gif" src={item.url} poster={item.poster} autoPlay loop muted playsInline onError={fail} />;
  }
  if (item.kind === 'sticker') {
    return isVideoFile(item.url, item.mime) ? (
      <video className="media-sticker" src={item.url} autoPlay loop muted playsInline onError={fail} />
    ) : (
      <img className="media-sticker" src={item.url} alt="" loading="lazy" onError={fail} />
    );
  }
  return (
    <a href={item.url} target="_blank" rel="noreferrer">
      <img className={item.kind === 'gif' ? 'media-gif' : 'media-img'} src={item.url} alt="" loading="lazy" onError={fail} />
    </a>
  );
}

function Preview({ p }: { p: LinkPreview }) {
  return (
    <a className={`preview preview-${p.site}`} href={p.url} target="_blank" rel="noreferrer">
      <div className="preview-head">
        {p.avatar && <img className="preview-avatar" src={p.avatar} alt="" loading="lazy" />}
        {p.site === 'x' && <Icon name="x" size={12} />}
        {p.author && <b>{p.author}</b>}
        {p.handle && <span className="muted">@{p.handle}</span>}
        {!p.author && p.title && <b>{p.title}</b>}
      </div>
      {p.text && <div className="preview-text">{p.text}</div>}
      {p.image && <img className="preview-img" src={p.image} alt="" loading="lazy" />}
    </a>
  );
}

export function MessageRow({
  m,
  tokens,
  onSelect,
  favorites = [],
  continued = false,
  discord = false,
  autoChart = false,
  compactEmbeds = true,
  chartProvider = 'basedbot',
  onAuthorChanged,
}: {
  m: FeedMessage;
  tokens: Record<string, TokenInfo>;
  onSelect?: (address: string) => void;
  favorites?: string[];
  /** same author as the message above within a few minutes: no avatar/header (Discord grouping) */
  continued?: boolean;
  /** Discord-style presentation (focused channel view) */
  discord?: boolean;
  autoChart?: boolean;
  compactEmbeds?: boolean;
  chartProvider?: import('../format').ChartProvider;
  /** a menu action changed favorites / bot policy / blacklist: reload config */
  onAuthorChanged?: () => void;
}) {
  const fav = !m.isBot && isFavorite(favorites, m.author);
  return (
    <div
      className={`row row-${m.source}${m.repeat ? ' row-repeat' : ''}${m.isBot ? ' row-bot' : ''}${m.hidden ? ' row-hidden' : ''}${fav ? ' row-fav' : ''}${
        discord ? ' row-discord' : ''
      }${continued ? ' row-continued' : ''}`}
    >
      {continued ? (
        <span className="row-gutter-time">{fmtTime(m.ts).replace(/:\d\d(?=\s|$)/, '')}</span>
      ) : (
        <Avatar src={m.avatar} name={m.author} size={discord ? 40 : 32} crown={fav} />
      )}
      <div className="row-main">
        {!continued && (
        <div className="row-meta">
          <span className="author">{m.author}</span>
          {m.isBot && <span className="bot-tag">bot</span>}
          {m.hidden && <span className="bot-tag hidden-tag">hidden</span>}
          <AuthorMenu author={m.author} link={m.link} favorite={fav} bot={m.isBot} hidden={!!m.hidden} onChanged={onAuthorChanged} />
          <span className="time">
            {m.link ? (
              <a href={m.link} target="_blank" rel="noreferrer">
                {fmtTime(m.ts)}
              </a>
            ) : (
              fmtTime(m.ts)
            )}
          </span>
          {!discord && (
            <span className="chat-tag" title={m.chatName}>
              {m.chatAvatar ? <Avatar src={m.chatAvatar} name={m.chatName} size={14} /> : <Logo source={m.source} size={11} />}
              <span className="chat-tag-name">{m.chatName}</span>
            </span>
          )}
        </div>
        )}
        {m.replyTo && (
          <div className="reply" title={m.replyTo.text}>
            <span className="reply-arrow">↩</span> <b>{m.replyTo.author}</b> <RichText text={m.replyTo.text} />
          </div>
        )}
        {(m.embeds?.length ? m.body : m.text) && (
          <div className="row-text">
            <RichText text={m.embeds?.length ? m.body ?? '' : m.text} contracts={m.contracts.map((c) => c.address)} />
            {m.hasAttachment && !m.media?.length && (
              <span className="attach" title="has attachment">
                {' '}
                📎
              </span>
            )}
          </div>
        )}
        {m.embeds?.map((e, i) => (
          <Embed key={i} e={e} contracts={m.contracts.map((c) => c.address)} compact={compactEmbeds} />
        ))}
        {m.media && m.media.length > 0 && (
          <div className="media">
            {m.media.map((x) => (
              <Media key={x.url} item={x} />
            ))}
          </div>
        )}
        {m.previews && m.previews.length > 0 && (
          <div className="previews">
            {m.previews.map((p) => (
              <Preview key={p.url} p={p} />
            ))}
          </div>
        )}
        {m.reactions && m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <span key={r.key} className="reaction" title={r.name}>
                {r.imageUrl ? <img src={r.imageUrl} alt={r.name} /> : r.name} <span className="reaction-n">{r.count}</span>
              </span>
            ))}
          </div>
        )}
        {m.contracts.length > 0 && (
          <div className="row-contracts">
            {m.contracts.map((c) => (
              <TokenChip key={c.chain + c.address} c={c} t={tokens[c.address]} onSelect={onSelect} autoChart={autoChart} chartProvider={chartProvider} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
