import type { FeedMessage, TokenInfo } from '../types';
import { fmtTime } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { TokenChip } from './TokenChip';
import { api } from '../api';

export function MessageRow({ m, tokens }: { m: FeedMessage; tokens: Record<string, TokenInfo> }) {
  return (
    <div className={`row row-${m.source}${m.repeat ? ' row-repeat' : ''}${m.isBot ? ' row-bot' : ''}`}>
      <Avatar src={m.avatar} name={m.author} />
      <div className="row-main">
        <div className="row-meta">
          <span className="author">{m.author}</span>
          {m.isBot && <span className="bot-tag">bot</span>}
          {!m.isBot && (
            <button
              className="block"
              title={`blacklist ${m.author} (never counts as a caller)`}
              onClick={() => void api.blacklistAdd(m.author).catch(() => {})}
            >
              🚫
            </button>
          )}
          <span className="time">
            {m.link ? (
              <a href={m.link} target="_blank" rel="noreferrer">
                {fmtTime(m.ts)}
              </a>
            ) : (
              fmtTime(m.ts)
            )}
          </span>
          <span className="chat-tag">
            <Logo source={m.source} size={11} /> {m.chatName}
          </span>
        </div>
        {m.replyTo && (
          <div className="reply" title={m.replyTo.text}>
            <span className="reply-arrow">↩</span> <b>{m.replyTo.author}</b> {m.replyTo.text}
          </div>
        )}
        <div className="row-text">
          {m.text}
          {m.hasAttachment && (
            <span className="attach" title="has attachment">
              {' '}
              📎
            </span>
          )}
        </div>
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
              <TokenChip key={c.chain + c.address} c={c} t={tokens[c.address]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
