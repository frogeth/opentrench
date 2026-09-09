/**
 * Pulls token metadata (website / twitter / telegram / name / symbol) out of a
 * message that mentions a contract. Works on Discord markdown links and on
 * Telegram entity links (where the visible label is often just an emoji).
 */

export interface LinkIn {
  label: string;
  url: string;
}

export interface ExtractedMeta {
  website?: string;
  twitter?: string;
  telegram?: string;
  name?: string;
  symbol?: string;
}

const MARKDOWN_LINK = /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g;
const BARE_URL = /https?:\/\/[^\s<>()\]]+/g;

/** Hosts that are tools, charts, explorers or aggregators — never a project website. */
const TOOL_HOSTS = [
  'dexscreener.com',
  'dextools.io',
  'defined.fi',
  'geckoterminal.com',
  'birdeye.so',
  'gmgn.ai',
  'tinyastro.io',
  'padre.gg',
  'okx.com',
  'etherscan.io',
  'basescan.org',
  'bscscan.com',
  'arbiscan.io',
  'polygonscan.com',
  'solscan.io',
  'solana.fm',
  'explorer.solana.com',
  'discord.com',
  'discord.gg',
  'discordapp.com',
  'lens.google.com',
  'pump.fun',
  'axiom.trade',
  'bullx.io',
  'rugcheck.xyz',
  'jup.ag',
  'raydium.io',
  'uniswap.org',
  'app.uniswap.org',
  'photon-sol.tinyastro.io',
  'dexcheck.ai',
  'cielo.finance',
  'coingecko.com',
  'coinmarketcap.com',
  'google.com',
  'youtube.com',
  'youtu.be',
  'tenor.com',
  'giphy.com',
  'cdn.discordapp.com',
  'media.discordapp.net',
];

function hostOf(url: string): { host: string; path: string; search: string } | null {
  try {
    const u = new URL(url);
    return { host: u.hostname.toLowerCase().replace(/^www\./, ''), path: u.pathname, search: u.search };
  } catch {
    return null;
  }
}

function isToolHost(host: string): boolean {
  return TOOL_HOSTS.some((t) => host === t || host.endsWith('.' + t));
}

type Kind = 'website' | 'twitter' | 'telegram' | null;

function classify(url: string): Kind {
  const u = hostOf(url);
  if (!u) return null;
  const { host, path, search } = u;

  if (host === 'x.com' || host === 'twitter.com' || host === 'mobile.twitter.com') {
    const first = path.split('/').filter(Boolean)[0] ?? '';
    if (!first || ['search', 'i', 'intent', 'home', 'explore', 'hashtag'].includes(first)) return null;
    return 'twitter';
  }
  if (host === 't.me' || host === 'telegram.me') {
    const segs = path.split('/').filter(Boolean);
    if (segs.length !== 1) return null; // /RickBurpBot/dsapp, /c/..., /+invite is fine? keep simple
    const name = segs[0];
    if (search.includes('start')) return null; // bot deep link
    if (/bot$/i.test(name)) return null;
    if (name.toLowerCase() === 'rick') return null;
    return 'telegram';
  }
  if (isToolHost(host)) return null;
  return 'website';
}

/** Rick header: "Name [255K/-11.3%] - SYM/QUOTE" (after markdown/bold stripping). */
const HEADER_RE = /^\s*(.{1,64}?)\s*\[[^\]]*\]\s*-\s*\$?([A-Za-z0-9_.]{1,20})\/[A-Za-z0-9_.]{1,20}\b/m;

export function extractLinks(text: string, entityLinks: LinkIn[]): ExtractedMeta {
  const out: ExtractedMeta = {};
  const links: LinkIn[] = [...entityLinks];

  for (const m of text.matchAll(MARKDOWN_LINK)) links.push({ label: m[1], url: m[2] });
  const stripped = text.replace(MARKDOWN_LINK, '$1');
  for (const m of stripped.matchAll(BARE_URL)) links.push({ label: m[0], url: m[0] });

  for (const l of links) {
    const kind = classify(l.url);
    if (kind && !out[kind]) out[kind] = l.url;
  }

  const header = stripped.replace(/\*\*/g, '').match(HEADER_RE);
  if (header) {
    const name = header[1].replace(/[*_`]/g, '').trim();
    if (name) out.name = name;
    out.symbol = header[2];
  }
  return out;
}
