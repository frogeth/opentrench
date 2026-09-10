import { createContext, useContext, useState, type ReactNode } from 'react';

/** A container can claim link clicks (return true = handled, default prevented). The Cove column uses it for the bot's deep links. */
export const LinkInterceptContext = createContext<((href: string) => boolean) | null>(null);
import { copyText } from '../format';

// Discord custom emoji on the wire: <:name:id> or <a:name:id> (animated).
const EMOJI_RE = /<(a?):([A-Za-z0-9_~]+):(\d{10,25})>/g;

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
 * One pass over the text with every inline construct we understand, in the
 * order Discord resolves them: inline code (nothing renders inside it),
 * markdown links, bold / underline / strike / italic (recursive), suppressed
 * <urls>, bare urls, custom emoji, mentions, and contract addresses.
 */
function buildRe(contracts: string[]): RegExp {
  const parts = [
    '(?<code>`[^`\\n]+`)',
    '(?<link>\\[[^\\]\\n]+\\]\\(https?:\\/\\/[^\\s)]+\\))',
    '(?<bold>\\*\\*[^\\n]+?\\*\\*)',
    '(?<under>__[^\\n]+?__)',
    '(?<strike>~~[^\\n]+?~~)',
    '(?<ital>\\*[^*\\n]+\\*)',
    '(?<angle><https?:\\/\\/[^\\s>]+>)',
    '(?<url>https?:\\/\\/[^\\s<>)]+)',
    '(?<emoji><a?:[A-Za-z0-9_~]+:\\d{10,25}>)',
    '(?<mention><(?:@!?|@&|#)\\d{10,25}>)',
  ];
  if (contracts.length) parts.push(`(?<ca>${contracts.map(escapeRe).join('|')})`);
  return new RegExp(parts.join('|'), 'gi');
}

function Link({ href, children }: { href: string; children: ReactNode }) {
  const intercept = useContext(LinkInterceptContext);
  return (
    <a
      className="md-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        e.stopPropagation();
        if (intercept?.(href)) e.preventDefault();
      }}
    >
      {children}
    </a>
  );
}

let key = 0;

function render(text: string, contracts: string[], re: RegExp, size: number, jumbo: boolean, depth: number): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  const inner = (s: string) => (depth < 4 ? render(s, contracts, re, size, jumbo, depth + 1) : s);
  const isCa = (s: string) => contracts.some((c) => c.toLowerCase() === s.toLowerCase());
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const g = m.groups ?? {};
    const k = key++;
    if (g.code) {
      const s = m[0].slice(1, -1);
      out.push(isCa(s) ? <CA key={k} text={s} /> : <code key={k} className="md-code">{s}</code>);
    } else if (g.link) {
      const lm = /^\[([^\]]+)\]\((.+)\)$/.exec(m[0])!;
      out.push(<Link key={k} href={lm[2]}>{inner(lm[1])}</Link>);
    } else if (g.bold) out.push(<b key={k}>{inner(m[0].slice(2, -2))}</b>);
    else if (g.under) out.push(<u key={k}>{inner(m[0].slice(2, -2))}</u>);
    else if (g.strike) out.push(<s key={k}>{inner(m[0].slice(2, -2))}</s>);
    else if (g.ital) out.push(<i key={k}>{inner(m[0].slice(1, -1))}</i>);
    else if (g.angle) {
      const u = m[0].slice(1, -1);
      out.push(<Link key={k} href={u}>{u}</Link>);
    } else if (g.url) out.push(<Link key={k} href={m[0]}>{m[0]}</Link>);
    else if (g.emoji) {
      const em = /^<(a?):([A-Za-z0-9_~]+):(\d+)>$/.exec(m[0])!;
      out.push(<Emoji key={k} id={em[3]} name={em[2]} animated={em[1] === 'a'} size={size} jumbo={jumbo} />);
    } else if (g.mention) {
      const kind = m[0].startsWith('<#') ? '#channel' : m[0].startsWith('<@&') ? '@role' : '@user';
      out.push(<span key={k} className="mention">{kind}</span>);
    } else if (g.ca) out.push(<CA key={k} text={m[0]} />);
    last = i + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Message text with Discord markdown, custom emoji (emoji-only messages
 * render big like stickers) and contract addresses turned into click-to-copy.
 */
export function RichText({ text, contracts = [] }: { text: string; contracts?: string[] }) {
  const stripped = text.replace(EMOJI_RE, '').replace(/\s+/g, '');
  const jumbo = stripped.length === 0 && EMOJI_RE.test(text);
  EMOJI_RE.lastIndex = 0;
  return <>{render(text, contracts, buildRe(contracts), jumbo ? 96 : 22, jumbo, 0)}</>;
}
