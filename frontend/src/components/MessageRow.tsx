import type { FeedMessage, TokenInfo } from '../types';
import { fmtTime } from '../format';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { TokenChip } from './TokenChip';

export function MessageRow({ m, tokens }: { m: FeedMessage; tokens: Record<string, TokenInfo> }) {
  return (
    <div className={`row row-${m.source}${m.repeat ? ' row-repeat' : ''}${m.isBot ? ' row-bot' : ''}`}>
      <Avatar src={m.avatar} name={m.author} />
      <div className="row-main">
        <div className="row-meta">
          <span className="author">{m.author}</span>
          {m.isBot && <span className="bot-tag">bot</span>}
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
        <div className="row-text">
          {m.text}
          {m.hasAttachment && (
            <span className="attach" title="has attachment">
              {' '}
              📎
            </span>
          )}
        </div>
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
