import { useState, type ReactNode } from 'react';
import { copyText } from '../format';

// Discord custom emoji on the wire: <:name:id> or <a:name:id> (animated).
const EMOJI_RE = /<(a?):([A-Za-z0-9_~]+):(\d{10,25})>/g;
// Discord mentions / channels / timestamps we can at least make readable.
const MENTION_RE = /<(@!?|@&|#)(\d{10,25})>/g;

function emojiUrl(id: string, animated: boolean, size: number): string {
  return `https://cdn.discordapp.com/emojis/${id}.${animated ? 'gif' : 'png'}?size=${size}`;
}

function Emoji({ id, name, animated, size, jumbo }: { id: string; name: string; animated: boolean; size: number; jumbo: boolean }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className="emoji-name">:{name}:</span>;
  return (
    <img
      className={`emoji${jumbo ? ' emoji-jumbo' : ''}`}
      src={emojiUrl(id, animated, size)}
      alt={`:${name}:`}
      title={`:${name}:`}
      loading="lazy"
      style={{ width: size, height: size }}
      onError={() => setBroken(true)}
    />
  );
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A contract address inside message text: click to copy. */
function CA({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className={`ca${copied ? ' ca-copied' : ''}`}
      title="click to copy"
      onClick={(e) => {
        e.stopPropagation();
        void copyText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
    >
      {text}
      {copied && <span className="ca-tip">copied</span>}
    </span>
  );
}

/**
 * Message text with Discord custom emoji rendered inline (emoji-only messages
 * render big like stickers) and contract addresses turned into click-to-copy.
 */
export function RichText({ text, contracts = [] }: { text: string; contracts?: string[] }) {
  const stripped = text.replace(EMOJI_RE, '').replace(/\s+/g, '');
  const jumbo = stripped.length === 0 && EMOJI_RE.test(text);
  EMOJI_RE.lastIndex = 0;
  const size = jumbo ? 96 : 22;
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  const caPart = contracts.length ? `|(${contracts.map(escapeRe).join('|')})` : '';
  const combined = new RegExp(`${EMOJI_RE.source}|${MENTION_RE.source}${caPart}`, 'gi');
  for (const m of text.matchAll(combined)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    if (m[6]) {
      out.push(<CA key={k++} text={m[0]} />);
    } else if (m[3]) {
      out.push(<Emoji key={k++} id={m[3]} name={m[2]} animated={m[1] === 'a'} size={size} jumbo={jumbo} />);
    } else if (m[4]) {
      const kind = m[4];
      out.push(
        <span key={k++} className="mention">
          {kind === '#' ? '#channel' : kind === '@&' ? '@role' : '@user'}
        </span>,
      );
    }
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
