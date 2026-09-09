import type { FeedMessage, TokenInfo } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { TokenCard } from './TokenCard';

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function MessageRow({ m, tokens }: { m: FeedMessage; tokens: Record<string, TokenInfo> }) {
  return (
    <div className={`row row-${m.source}${m.repeat ? ' row-repeat' : ''}${m.isBot ? ' row-bot' : ''}`}>
      <Avatar src={m.avatar} name={m.author} />
      <div className="row-main">
        <div className="row-meta">
          <Logo source={m.source} />
          <span className="chat">{m.chatName}</span>
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
              <TokenCard key={c.chain + c.address} c={c} t={tokens[c.address]} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
