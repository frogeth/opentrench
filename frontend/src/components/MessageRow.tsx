import type { FeedMessage } from '../types';
import { ContractChip } from './ContractChip';

function fmtTime(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function MessageRow({ m }: { m: FeedMessage }) {
  return (
    <div className={`row row-${m.source}`}>
      <div className="row-meta">
        <span className={`badge badge-${m.source}`}>{m.source === 'discord' ? 'DC' : 'TG'}</span>
        <span className="chat">{m.chatName}</span>
        <span className="author">{m.author}</span>
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
            <ContractChip key={c.chain + c.address} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}
