import { useMemo, useState } from 'react';
import type { ColumnDef, ColumnFilters, DiscordChannel, VampyFeedInfo, WatchedChat } from '../api';
import type { PluginInfo, Source } from '../types';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { SOUNDS, playSound } from '../sounds';
import { filtersActive } from '../filters';

/** a chat's key in a column's list; a plugin chat's id is already the whole `plugin:<plugin>:<chat>` key */
export const chatKey = (w: { source: string; id: string }) => (w.source === 'plugin' ? w.id : `${w.source}:${w.id}`);

const CHAINS: [string, string][] = [
  ['solana', 'Solana'], ['ethereum', 'Ethereum'], ['base', 'Base'], ['bsc', 'BSC'], ['robinhood', 'Robinhood'],
  ['hyperevm', 'HyperEVM'], ['arbitrum', 'Arbitrum'], ['monad', 'Monad'], ['blast', 'Blast'], ['avalanche', 'Avalanche'],
  ['ink', 'Ink'], ['megaeth', 'MegaETH'], ['plasma', 'Plasma'], ['story', 'Story'], ['stable', 'Stable'], ['arc', 'Arc'],
];
const LAUNCHPADS: [string, string][] = [
  ['pumpfun', 'Pump.fun'], ['letsbonk', 'letsbonk'], ['bankr', 'Bankr'], ['stonks', 'Stonks'], ['pons', 'Pons'], ['genius', 'Genius'],
  ['o1', 'o1'], ['virtuals', 'Virtuals'], ['flap', 'Flap'], ['clanker', 'Clanker'], ['long', 'Long'],
  ['argus', 'Argus'], ['warp', 'Warp'], ['peach', 'Peach'], ['dyor', 'DYOR'], ['synthra', 'Synthra'],
];
const MUST: [string, string][] = [
  ['website', 'Website'], ['twitter', 'Twitter'], ['telegram', 'Telegram'], ['social', '≥1 social'], ['image', 'Image'], ['devSold', 'Dev sold'], ['lpLocked', 'LP locked'],
];
/** The column types on offer, as cards: what each one shows in a few words. */
const TYPE_CARDS: { t: ColumnDef['type']; icon: import('./Icon').IconName; name: string; blurb: string }[] = [
  { t: 'chat', icon: 'chat', name: 'Messages', blurb: 'live chat from the channels you pick' },
  { t: 'calls', icon: 'calls', name: 'Calls', blurb: 'every contract as it gets called' },
  { t: 'callers', icon: 'people', name: 'Top Callers', blurb: 'who calls best, over a window' },
  { t: 'trending', icon: 'top', name: 'Trending', blurb: 'most-called tokens, 5m to 24h' },
  { t: 'cove', icon: 'send', name: 'Buy bot', blurb: 'Cove or BasedBot, one pane' },
  { t: 'tgbot', icon: 'telegram', name: 'Telegram bot', blurb: 'Cielo alerts, or any bot you talk to' },
  { t: 'j7', icon: 'x', name: 'J7', blurb: 'J7Tracker’s tweet stream' },
  { t: 'web', icon: 'globe', name: 'Website', blurb: 'any page, living in a column' },
  { t: 'mints', icon: 'mint', name: 'MintGo', blurb: 'NFT mints as they happen' },
  { t: 'nftvol', icon: 'sea', name: 'NFT Volume', blurb: 'trending & top collections' },
  { t: 'osmint', icon: 'wallet', name: 'NFT Mint', blurb: 'mint an OpenSea drop with your wallet' },
  { t: 'plugin', icon: 'plug', name: 'Plugin', blurb: 'a custom column from a plugin you installed' },
  { t: 'vampy', icon: 'vampy', name: 'Vampy', blurb: 'a feed you built on vampy.app' },
];

/** Ready-made Website columns; "Custom" takes any address. */
const WEB_PRESETS: { name: string; url: string; blurb: string }[] = [
  { name: 'MintGo', url: 'https://mintgo.fun', blurb: 'mint radar' },
  { name: 'Smart Money', url: 'https://smartmoney.sh', blurb: 'smart-money flows' },
];
/** Ready-made Telegram bot columns; "Custom" takes any bot's username. */
const BOT_PRESETS: { name: string; bot: string; blurb: string }[] = [
  { name: 'Cielo', bot: 'evmtrackerbot', blurb: 'wallet tracker alerts' },
  { name: 'Salpha', bot: 'salpha_research_bot', blurb: 'research reports; right-click a contract → Research' },
];
type NumKey = { [K in keyof ColumnFilters]-?: NonNullable<ColumnFilters[K]> extends number ? K : never }[keyof ColumnFilters];
const RANGES: { title: string; rows: [string, NumKey, NumKey, string][] }[] = [
  { title: 'Metrics', rows: [['Market cap', 'mcMin', 'mcMax', '$'], ['Liquidity', 'liqMin', 'liqMax', '$'], ['Volume 24h', 'volMin', 'volMax', '$'], ['MC / Liq', 'mcLiqMin', 'mcLiqMax', 'x']] },
  // "MC since first call" and "Times called" side by side: people read a bare "Multiplier" as the call count
  { title: 'Calls', rows: [['Times called', 'callsMin', 'callsMax', ''], ['MC since first call', 'multMin', 'multMax', 'x']] },
  { title: 'Activity', rows: [['Holders', 'holdersMin', 'holdersMax', ''], ['Age', 'ageMin', 'ageMax', 'min'], ['Txns 24h', 'txMin', 'txMax', ''], ['Buys', 'buysMin', 'buysMax', ''], ['Sells', 'sellsMin', 'sellsMax', '']] },
  { title: 'Distribution', rows: [['Top 10', 'top10Min', 'top10Max', '%'], ['Snipers', 'snipersMin', 'snipersMax', '%'], ['Insiders', 'insidersMin', 'insidersMax', '%'], ['Bundlers', 'bundlersMin', 'bundlersMax', '%'], ['Dev', 'devMin', 'devMax', '%']] },
];

function NameList({ title, hint, value, onChange, suggestions }: { title: string; hint: string; value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const [q, setQ] = useState('');
  const matches = q.trim() ? suggestions.filter((s) => s.toLowerCase().includes(q.toLowerCase()) && !value.includes(s)).slice(0, 8) : [];
  const add = (n: string) => {
    if (n.trim() && !value.includes(n.trim())) onChange([...value, n.trim()]);
    setQ('');
  };
  return (
    <div className="fsec">
      <div className="fsec-title">
        {title} <span className="muted">({value.length} selected)</span>
      </div>
      <div className="hint">{hint}</div>
      <div className="fnames">
        {value.map((n) => (
          <span key={n} className="fname">
            {n}
            <button onClick={() => onChange(value.filter((x) => x !== n))} title="remove">
              ✕
            </button>
          </span>
        ))}
      </div>
      <div className="fsearch">
        <Icon name="search" size={12} />
        <input value={q} placeholder="Search callers…" onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add(q)} />
      </div>
      {matches.length > 0 && (
        <div className="fsuggest">
          {matches.map((s) => (
            <button key={s} onClick={() => add(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Chips({ title, options, value, onChange, all }: { title: string; options: [string, string][]; value: string[]; onChange: (v: string[]) => void; all: string }) {
  return (
    <div className="fsec">
      <div className="fsec-title">{title}</div>
      <div className="fchips">
        {options.map(([k, label]) => (
          <button key={k} className={`fchip${value.includes(k) ? ' on' : ''}`} onClick={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])}>
            {label}
          </button>
        ))}
      </div>
      <div className="hint">{value.length === 0 ? all : `${value.length} selected`}</div>
    </div>
  );
}

/** Add or edit one column: type, title, channels on the left; filters and alerts on the right. */
export function ColumnEditor({
  col,
  watched,
  channels = [],
  callers = [],
  plugins = [],
  vampyFeeds = [],
  vampyKey = false,
  onSave,
  onClose,
}: {
  col?: ColumnDef;
  watched: WatchedChat[];
  channels?: DiscordChannel[];
  /** names seen in the feed, for the caller pickers */
  callers?: string[];
  /** every plugin the app knows about; the ones with a column of their own can fill a Plugin column */
  plugins?: PluginInfo[];
  /** the feeds built on vampy.app; one fills a Vampy column */
  vampyFeeds?: VampyFeedInfo[];
  /** a Vampy key is saved (the feeds list is empty until it connects) */
  vampyKey?: boolean;
  onSave: (c: ColumnDef) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<ColumnDef['type']>(col?.type === 'salpha' ? 'tgbot' : (col?.type ?? 'chat'));
  const [title, setTitle] = useState(col?.title ?? '');
  const [chats, setChats] = useState<string[]>(col?.chats ?? []);
  const [win, setWin] = useState<NonNullable<ColumnDef['window']>>(col?.window ?? '7d');
  const [alertOn, setAlertOn] = useState(col?.alert?.on ?? false);
  const [sound, setSound] = useState(col?.alert?.sound ?? 'ping');
  const [f, setF] = useState<ColumnFilters>(col?.filters ?? {});
  const [url, setUrl] = useState(col?.url ?? '');
  // a saved address that is not one of the presets is a custom one; a fresh column starts on the presets
  const [custom, setCustom] = useState(() => !!col?.url && !WEB_PRESETS.some((p) => p.url === col.url));
  const preset = custom ? undefined : WEB_PRESETS.find((p) => p.url === url.trim());
  const pickPreset = (p: (typeof WEB_PRESETS)[number]) => {
    setCustom(false);
    setUrl(p.url);
    // a title that was blank or another preset's name follows the pick; a typed one stays
    if (!title.trim() || WEB_PRESETS.some((q) => q.name === title.trim())) setTitle(p.name);
  };
  const pickCustom = () => {
    setCustom(true);
    if (WEB_PRESETS.some((p) => p.url === url.trim())) setUrl('');
    if (WEB_PRESETS.some((q) => q.name === title.trim())) setTitle('');
  };
  // a fresh column starts on the first preset; a Salpha column from before it became a preset edits as the Salpha bot
  const [bot, setBot] = useState(col?.bot ?? (col?.type === 'salpha' ? 'salpha_research_bot' : BOT_PRESETS[0].bot));
  const cleanBot = bot.trim().replace(/^@/, '');
  const botOk = /^[A-Za-z0-9_]{3,32}$/.test(cleanBot);
  const [customBot, setCustomBot] = useState(() => !!col?.bot && !BOT_PRESETS.some((p) => p.bot === col.bot));
  const botPreset = customBot ? undefined : BOT_PRESETS.find((p) => p.bot === cleanBot);
  const pickBotPreset = (p: (typeof BOT_PRESETS)[number]) => {
    setCustomBot(false);
    setBot(p.bot);
    if (!title.trim() || BOT_PRESETS.some((q) => q.name === title.trim())) setTitle(p.name);
  };
  const pickCustomBot = () => {
    setCustomBot(true);
    if (BOT_PRESETS.some((p) => p.bot === cleanBot)) setBot('');
    if (BOT_PRESETS.some((q) => q.name === title.trim())) setTitle('');
  };
  // only a plugin that is enabled and draws a column can fill one; the rest post to the feed instead
  const uiPlugins = useMemo(() => plugins.filter((p) => p.enabled && p.manifest?.ui), [plugins]);
  const [pluginId, setPluginId] = useState(col?.plugin ?? '');
  // the picked plugin may have been switched off since the column was made; it is still the column's plugin
  const pickedPlugin = plugins.find((p) => p.id === pluginId);
  const pickPlugin = (p: PluginInfo) => {
    setPluginId(p.id);
    const name = p.manifest?.name ?? p.id;
    // a blank title, or another plugin's name, follows the pick; a typed one stays
    if (!title.trim() || uiPlugins.some((q) => (q.manifest?.name ?? q.id) === title.trim())) setTitle(name);
  };
  // a Vampy column mirrors one feed; a feed removed on vampy.app since is still the column's feed
  const [feed, setFeed] = useState(col?.feed ?? '');
  const pickedFeed = vampyFeeds.find((x) => x.id === feed);
  const pickFeed = (x: VampyFeedInfo) => {
    setFeed(x.id);
    // a blank title, or another feed's title, follows the pick; a typed one stays
    if (!title.trim() || vampyFeeds.some((q) => q.title === title.trim())) setTitle(x.title);
  };
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [ranking, setRanking] = useState<NonNullable<ColumnDef['ranking']>>(col?.ranking ?? 'trending');
  const [timeframe, setTimeframe] = useState<NonNullable<ColumnDef['timeframe']>>(col?.timeframe ?? '1h');
  const set = <K extends keyof ColumnFilters>(k: K, v: ColumnFilters[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (k: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? undefined : Number(e.target.value));
  const isBot = type === 'cove' || type === 'salpha' || type === 'j7' || type === 'tgbot';
  const isWeb = type === 'web';
  const isNft = type === 'mints' || type === 'nftvol' || type === 'osmint';
  const isPlugin = type === 'plugin';
  const isVampy = type === 'vampy';
  /** what the column renders as: a Vampy column is a calls column for a call feed and a messages column for a message feed */
  const view: ColumnDef['type'] = isVampy ? (pickedFeed?.type === 'call' ? 'calls' : 'chat') : type;
  const all = chats.length === 0;
  const none = chats.includes('none');
  // "All channels" is stored as an empty list and shows as every box ticked; "none" is a
  // sentinel for nothing ticked. Unticking narrows to an explicit list; ticking the last one
  // back collapses to "all", unticking the last one becomes "none".
  const allKeys = useMemo(() => watched.map(chatKey), [watched]);
  const selected = all ? allKeys : none ? [] : chats;
  const commit = (next: string[]) => {
    const real = next.filter((k) => k !== 'none');
    setChats(real.length === 0 ? ['none'] : allKeys.length > 0 && allKeys.every((k) => real.includes(k)) ? [] : real);
  };
  const toggle = (k: string) => commit(selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k]);

  // Group by Discord server, channels under their category, then Telegram, then the plugins' chats.
  const groups = useMemo(() => {
    const cat = new Map(channels.map((c) => [c.id, c.category]));
    const m = new Map<string, { source: Source; label: string; avatar?: string; items: { w: WatchedChat; category?: string }[] }>();
    for (const w of watched) {
      const tail = w.source === 'discord' ? /\(([^)]*)\)\s*$/.exec(w.name)?.[1] : undefined;
      const server = w.source === 'discord' ? (tail === 'DM' ? 'Direct Messages' : tail ?? 'Discord') : w.source === 'plugin' ? 'Plugins' : w.source === 'vampy' ? 'Vampy' : 'Telegram';
      // keyed by source for the non-Discord groups, so a server actually named "Plugins" stays its own group
      const key = w.source === 'discord' ? `discord:${server}` : `${w.source}:`;
      const g = m.get(key) ?? { source: w.source, label: server, avatar: undefined, items: [] };
      if (!g.avatar && w.avatar && w.source === 'discord') g.avatar = w.avatar;
      g.items.push({ w, category: w.source === 'discord' ? cat.get(w.id) : undefined });
      m.set(key, g);
    }
    const rank = (k: string) => (k === 'vampy:' ? 3 : k === 'plugin:' ? 2 : k === 'telegram:' ? 1 : 0);
    return [...m.entries()].sort((a, b) => rank(a[0]) - rank(b[0]) || a[1].label.localeCompare(b[1].label));
  }, [watched, channels]);
  const shortName = (w: WatchedChat) => (w.source === 'discord' || w.source === 'vampy' ? w.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '') : w.name);
  const groupState = (items: { w: WatchedChat }[]) => {
    const n = items.filter(({ w }) => selected.includes(chatKey(w))).length;
    return n === 0 ? 'none' : n === items.length ? 'all' : 'some';
  };
  const toggleGroup = (items: { w: WatchedChat }[]) => {
    const keys = items.map(({ w }) => chatKey(w));
    commit(groupState(items) === 'all' ? selected.filter((k) => !keys.includes(k)) : [...new Set([...selected, ...keys])]);
  };

  // a pasted address without a scheme gets https://; anything that still is not http(s) is refused
  const cleanUrl = (() => {
    const u = url.trim();
    if (!u) return '';
    return /^[a-z][a-z0-9+.-]*:/i.test(u) ? u : `https://${u}`;
  })();
  const urlOk = /^https?:\/\/[^\s/]+/i.test(cleanUrl);
  const save = () => {
    const t = title.trim() || (type === 'calls' ? (all ? 'All Calls' : 'Calls') : type === 'callers' ? 'Top Callers' : type === 'trending' ? 'Trending' : type === 'cove' ? 'Cove' : type === 'salpha' ? 'Salpha' : type === 'j7' ? 'J7' : type === 'tgbot' ? (botPreset?.name ?? (botOk ? `@${cleanBot}` : 'Telegram bot')) : type === 'web' ? (preset?.name ?? (urlOk ? new URL(cleanUrl).hostname.replace(/^www\./, '') : 'Website')) : type === 'mints' ? 'MintGo' : type === 'nftvol' ? 'NFT Volume' : type === 'osmint' ? 'NFT Mint' : type === 'plugin' ? (pickedPlugin?.manifest?.name || pluginId || 'Plugin') : type === 'vampy' ? (pickedFeed?.title || 'Vampy') : all ? 'All Chats' : 'Chats');
    if (isWeb && !urlOk) {
      window.alert('Paste the address of the page to show (http:// or https://).');
      return;
    }
    if (type === 'tgbot' && !botOk) {
      window.alert('Enter the bot\'s username (letters, digits and _, like evmtrackerbot).');
      return;
    }
    if (isVampy && !feed) {
      window.alert('Pick the Vampy feed this column shows.');
      return;
    }
    if (!isWeb && !isNft && !isPlugin && !isVampy && none && watched.length > 0 && !window.confirm('No channels are selected, so this column will stay empty. Save anyway?')) return;
    const clean: ColumnFilters = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'string' && !v.trim())) (clean as any)[k] = v;
    // filters don't carry across a type change when their vocabulary differs: minQty is mints-only,
    // and chains means different things for mints (ethereum/robinhood/ink) vs calls/chat (token networks)
    if (type !== 'mints') delete clean.minQty;
    if (col && col.type !== type && (col.type === 'mints' || type === 'mints')) delete clean.chains;
    onSave({
      ...(col ?? {}),
      id: col?.id ?? `c${Date.now().toString(36)}`,
      type,
      title: t,
      chats: isWeb || isNft || isPlugin ? [] : isVampy ? [`vampy:${feed}`] : chats,
      ...(isWeb ? { url: cleanUrl } : {}),
      ...(isPlugin ? { plugin: pluginId } : {}),
      ...(isVampy ? { feed } : {}),
      ...(type === 'tgbot' ? { bot: cleanBot } : {}),
      ...(type === 'callers' ? { window: (['24h', '7d', '30d'] as const).includes(win as any) ? win : '7d' } : type === 'trending' ? { window: (['5m', '1h', '6h', '24h'] as const).includes(win as any) ? win : '1h' } : {}),
      ...(type === 'nftvol' ? { ranking, timeframe } : {}),
      ...(type === 'calls' || type === 'chat' || type === 'j7' || type === 'vampy' ? { alert: { on: alertOn, sound } } : {}),
      filters: Object.keys(clean).length ? clean : undefined,
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal fed">
        <div className="fed-head">
          <b>{col ? 'Edit column' : 'Add column'}</b>
          <button className="close" onClick={onClose} title="close">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="fed-body">
          {/* ---------- left: what & where ---------- */}
          <div className="fed-left">
            <div className="fed-type">
              {TYPE_CARDS.map((c) => (
                <button key={c.t} className={type === c.t ? 'active' : ''} onClick={() => setType(c.t)} aria-pressed={type === c.t}>
                  <span className="fed-card-head">
                    <Icon name={c.icon} size={14} /> <b>{c.name}</b>
                  </span>
                  <span className="fed-card-blurb">{c.blurb}</span>
                </button>
              ))}
            </div>
            <div className="fed-label">Feed name</div>
            <input className="fed-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'calls' ? 'All Calls' : type === 'callers' ? 'Top Callers' : type === 'trending' ? 'Trending' : type === 'cove' ? 'Cove' : type === 'salpha' ? 'Salpha' : type === 'j7' ? 'J7' : type === 'tgbot' ? (botPreset?.name ?? (botOk ? `@${cleanBot}` : 'Telegram bot')) : type === 'web' ? (preset?.name ?? (urlOk ? new URL(cleanUrl).hostname.replace(/^www\./, '') : 'Website')) : type === 'mints' ? 'MintGo' : type === 'nftvol' ? 'NFT Volume' : type === 'osmint' ? 'NFT Mint' : type === 'plugin' ? (pickedPlugin?.manifest?.name ?? 'Plugin') : type === 'vampy' ? (pickedFeed?.title ?? 'Vampy') : 'All Chats'} maxLength={40} />
            {isWeb && (
              <>
                <div className="fed-label">Site</div>
                <div className="fchips fed-sites">
                  {WEB_PRESETS.map((p) => (
                    <button key={p.url} className={`fchip${preset?.url === p.url ? ' on' : ''}`} onClick={() => pickPreset(p)} title={p.url}>
                      <Icon name="globe" size={11} /> {p.name} <span className="muted">· {p.blurb}</span>
                    </button>
                  ))}
                  <button className={`fchip${custom ? ' on' : ''}`} onClick={pickCustom}>
                    <Icon name="pencil" size={11} /> Custom
                  </button>
                </div>
                {custom && (
                  <>
                    <div className="fed-label">Address</div>
                    <input className="fed-input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" spellCheck={false} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
                  </>
                )}
                <div className="fed-bot-note hint">The page lives inside the column, like a browser tab, with clipboard access for its copy buttons. Sites that refuse embedding still load in the desktop app; the ↗ in the column header opens any of them in your browser.</div>
              </>
            )}
            {type === 'tgbot' && (
              <>
                <div className="fed-label">Bot</div>
                <div className="fchips fed-sites">
                  {BOT_PRESETS.map((p) => (
                    <button key={p.bot} className={`fchip${botPreset?.bot === p.bot ? ' on' : ''}`} onClick={() => pickBotPreset(p)} title={`@${p.bot}`}>
                      <Icon name="telegram" size={11} /> {p.name} <span className="muted">· {p.blurb}</span>
                    </button>
                  ))}
                  <button className={`fchip${customBot ? ' on' : ''}`} onClick={pickCustomBot}>
                    <Icon name="pencil" size={11} /> Custom
                  </button>
                </div>
                {customBot && (
                  <>
                    <div className="fed-label">Username</div>
                    <input className="fed-input" value={bot} onChange={(e) => setBot(e.target.value)} placeholder="@bot_username" spellCheck={false} autoFocus onKeyDown={(e) => e.key === 'Enter' && save()} />
                  </>
                )}
              </>
            )}
            {isBot && (
              <div className="fed-bot-note hint">
                {type === 'cove' ? 'Your buy bot — Cove or BasedBot, whichever is picked in ⚙ → Trading. Buy buttons and right-click → Buy land here.' : type === 'salpha' ? 'Your conversation with @salpha_research_bot. Right-click a contract → Research sends it here.' : type === 'tgbot' ? `Your Telegram conversation with ${botOk ? `@${cleanBot}` : 'the bot'}, live, with its buttons. Start the bot in Telegram once (press Start there) if you never have; Cielo's is @evmtrackerbot.` : 'J7Tracker’s live tweet feed, with the calls each tweet touches. Needs your J7 session id in ⚙ → Accounts.'}
              </div>
            )}
            {isNft && (
              <div className="fed-bot-note hint">
                {type === 'mints' ? 'Every mint MintGo sees on Ethereum, Robinhood Chain and Ink. Click a mint for its X, OpenSea and website links, and a Mint button.' : type === 'nftvol' ? "OpenSea's trending or top collections with floor, volume and sales. Switch 1H / 1D in the column header." : 'Paste a collection (slug, OpenSea link or address), see the open stage and price, and mint with the wallet from ⚙ → Trading.'}
              </div>
            )}
            {isPlugin && (
              <>
                <div className="fed-label">Plugin</div>
                {uiPlugins.length === 0 ? (
                  <div className="hint">No plugin with a column is enabled. Plugins that only post to the feed show up in the channel picker instead.</div>
                ) : (
                  <div className="fchips fed-sites">
                    {uiPlugins.map((p) => (
                      <button key={p.id} className={`fchip${pluginId === p.id ? ' on' : ''}`} onClick={() => pickPlugin(p)} title={p.manifest?.description || undefined}>
                        <Icon name="plug" size={11} /> {p.manifest?.name ?? p.id}
                      </button>
                    ))}
                  </div>
                )}
                {pluginId && !uiPlugins.some((p) => p.id === pluginId) && (
                  <div className="hint">{pickedPlugin?.manifest?.name ?? pluginId} is not enabled right now, so this column stays empty until you enable it in ⚙ → Plugins.</div>
                )}
                <div className="fed-bot-note hint">The plugin draws this column itself, inside its own sandbox. Add, approve and remove plugins in ⚙ → Plugins.</div>
              </>
            )}
            {isVampy && (
              <>
                <div className="fed-label">Feed</div>
                {!vampyKey ? (
                  <div className="hint">No Vampy key yet. Paste your vampy.app API key in ⚙ → Accounts → Vampy, and your feeds show up here.</div>
                ) : vampyFeeds.length === 0 ? (
                  <div className="hint">No feeds yet: either Vampy is still connecting, or nothing is built on vampy.app under this key.</div>
                ) : (
                  <div className="fchips fed-sites">
                    {vampyFeeds.map((x) => (
                      <button key={x.id} className={`fchip${feed === x.id ? ' on' : ''}`} onClick={() => pickFeed(x)} title={x.channels.map((c) => [c.name, c.server].filter(Boolean).join(' · ')).join('\n') || undefined}>
                        <Icon name={x.type === 'call' ? 'calls' : 'chat'} size={11} /> {x.title} <span className="muted">· {x.type === 'call' ? 'calls' : 'messages'}</span>
                      </button>
                    ))}
                  </div>
                )}
                {feed && vampyKey && vampyFeeds.length > 0 && !pickedFeed && <div className="hint">This column's feed is not on vampy.app any more, so it stays empty until you pick another.</div>}
                <div className="fed-bot-note hint">
                  {view === 'calls' ? 'Every call of this feed as a call card, priced live, with the market cap Vampy recorded at the call. The same calls also count in All Calls, Trending and Top Callers.' : 'The messages of this feed, live, with contracts detected. The feed is also in the channel picker of any Messages or Calls column.'}
                </div>
              </>
            )}
            {!isBot && !isWeb && !isNft && !isPlugin && !isVampy && (
            <>
            <div className="fed-label">
              Channels <span className="muted">({all ? 'all' : none ? 'none' : `${chats.length} of ${allKeys.length}`})</span>
              <span className="fed-links">
                {!all && (
                  <button className="fed-link" onClick={() => setChats([])} title="tick everything">
                    select all
                  </button>
                )}
                {!none && (
                  <button className="fed-link" onClick={() => setChats(['none'])} title="untick everything">
                    deselect all
                  </button>
                )}
              </span>
            </div>
            <div className="fed-tree">
              {groups.map(([key, g]) => {
                const server = g.label;
                const st = groupState(g.items);
                const isOpen = open[key] ?? false;
                let lastCat: string | undefined;
                return (
                  <div key={key} className="ftree-group">
                    <div className="ftree-head">
                      <button className="ftree-arrow" onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))} aria-label={isOpen ? 'collapse' : 'expand'}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                      <input type="checkbox" checked={st === 'all'} ref={(el) => el && (el.indeterminate = st === 'some')} onChange={() => toggleGroup(g.items)} />
                      {g.avatar ? <Avatar src={g.avatar} name={server} size={18} /> : <Logo source={g.source} size={14} />}
                      <b onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen }))}>{server}</b>
                      <span className="muted">{g.items.length}</span>
                    </div>
                    {isOpen &&
                      g.items.map(({ w, category }) => {
                        const showCat = category !== lastCat;
                        lastCat = category;
                        return (
                          <div key={chatKey(w)}>
                            {showCat && category && <div className="ftree-cat">{category}</div>}
                            <label className="ftree-item">
                              <input type="checkbox" checked={selected.includes(chatKey(w))} onChange={() => toggle(chatKey(w))} />
                              {w.source === 'discord' && !/\(DM\)\s*$/.test(w.name) ? <span className="muted">#</span> : w.avatar ? <Avatar src={w.avatar} name={w.name} size={14} /> : <Logo source={w.source} size={12} />}
                              <span className="ftree-name">{shortName(w)}</span>
                            </label>
                          </div>
                        );
                      })}
                  </div>
                );
              })}
              {watched.length === 0 && <div className="hint">No watched chats yet. Add some with the + in the rail.</div>}
            </div>
            </>
            )}
          </div>

          {/* ---------- right: filters & alerts ---------- */}
          <div className="fed-right">
            {isBot && type !== 'j7' && <div className="hint">Nothing to filter here — this column shows one bot conversation.</div>}
            {isWeb && <div className="hint">Nothing to filter here — this column shows a web page.</div>}
            {isPlugin && <div className="hint">Nothing to filter here — the plugin decides what its own column shows.</div>}
            {isVampy && !pickedFeed && <div className="hint">Pick a feed on the left: a call feed gets the calls filters, a message feed the message filters.</div>}
            {type === 'mints' && (
              <>
                <Chips title="Chains" options={[['ethereum', 'Ethereum'], ['robinhood', 'Robinhood'], ['ink', 'Ink']]} value={f.chains ?? []} onChange={(v) => set('chains', v)} all="all chains" />
                <div className="fsec">
                  <div className="fsec-title">Minimum quantity</div>
                  <input className="fed-input" type="number" min={1} value={f.minQty ?? ''} onChange={(e) => set('minQty', e.target.value === '' ? undefined : Number(e.target.value))} placeholder="any" />
                </div>
              </>
            )}
            {type === 'nftvol' && (
              <>
                <div className="fsec">
                  <div className="fsec-title">List</div>
                  <div className="fchips">
                    {(['trending', 'top'] as const).map((r) => <button key={r} className={`fchip${ranking === r ? ' on' : ''}`} onClick={() => setRanking(r)}>{r === 'trending' ? 'Trending' : 'Top'}</button>)}
                  </div>
                </div>
                <div className="fsec">
                  <div className="fsec-title">Window</div>
                  <div className="fchips">
                    {(['1h', '1d'] as const).map((t) => <button key={t} className={`fchip${timeframe === t ? ' on' : ''}`} onClick={() => setTimeframe(t)}>{t.toUpperCase()}</button>)}
                  </div>
                </div>
              </>
            )}
            {type === 'osmint' && <div className="hint">Nothing to filter here — this column is your mint window.</div>}
            {type === 'j7' && (
              <div className="fsec">
                <div className="fsec-title">Alert</div>
                <label className="check">
                  <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Ping me when a starred account tweets
                </label>
                <div className="hint">Star an account on any of its tweets. With this off (or the bell in the column header off), starred accounts stay quiet.</div>
                <div className="fchips">
                  {SOUNDS.map((s) => (
                    <button key={s} className={`fchip${sound === s ? ' on' : ''}`} onClick={() => { setSound(s); playSound(s, { force: true }); }} title={`use “${s}”`}>
                      <Icon name="play" size={9} /> {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {view === 'chat' && (
              <>
                <div className="fsec">
                  <div className="fsec-title">Search (optional)</div>
                  <input className="fed-input" placeholder="e.g. announcement" value={f.search ?? ''} onChange={(e) => set('search', e.target.value)} />
                </div>
                <div className="fsec">
                  <div className="fsec-title">Message filter</div>
                  <div className="fchips">
                    <button className={`fchip${f.excludeBots ? ' on' : ''}`} onClick={() => set('excludeBots', !f.excludeBots)}>
                      Exclude bots
                    </button>
                    <button className={`fchip${f.contractsOnly ? ' on' : ''}`} onClick={() => set('contractsOnly', !f.contractsOnly)}>
                      Contracts only
                    </button>
                    {f.contractsOnly && (
                      <>
                        <span className="fchips fchips-inline" title="also keep the caller's next messages after a call, so their thesis shows with the contract">
                          <span className="muted">+ caller's next</span>
                          {[0, 1, 2, 3].map((n) => (
                            <button key={n} className={`fchip${(f.thesis ?? 0) === n ? ' on' : ''}`} onClick={() => set('thesis', n)}>
                              {n}
                            </button>
                          ))}
                        </span>
                        <span className="fchips fchips-inline" title="and the caller's messages just before the call">
                          <span className="muted">+ caller's previous</span>
                          {[0, 1, 2, 3].map((n) => (
                            <button key={n} className={`fchip${(f.thesisBefore ?? 0) === n ? ' on' : ''}`} onClick={() => set('thesisBefore', n)}>
                              {n}
                            </button>
                          ))}
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </>
            )}
            {(view === 'calls' || view === 'chat') && (
              <>
                <NameList title="Show only" hint={view === 'calls' ? 'Only calls by these callers' : 'Only messages from these callers'} value={f.showOnly ?? []} onChange={(v) => set('showOnly', v)} suggestions={callers} />
                <NameList title="Muted callers" hint={view === 'calls' ? 'Hide calls by these callers' : 'Hide messages from these callers'} value={f.muted ?? []} onChange={(v) => set('muted', v)} suggestions={callers} />
              </>
            )}
            {view === 'calls' && (
              <>
                <div className="fed-cols">
                  <div>
                    <Chips title="Chains" options={CHAINS} value={f.chains ?? []} onChange={(v) => set('chains', v)} all="All chains" />
                    <Chips title="Launchpads" options={LAUNCHPADS} value={f.launchpads ?? []} onChange={(v) => set('launchpads', v)} all="All launchpads" />
                    <Chips title="Must have" options={MUST} value={f.must ?? []} onChange={(v) => set('must', v)} all="No requirements" />
                  </div>
                  <div>
                    {RANGES.map((sec) => (
                      <div key={sec.title} className="fsec">
                        <div className="fsec-title">{sec.title}</div>
                        <div className="franges">
                          {sec.rows.map(([label, minK, maxK, unit]) => (
                            <div key={minK} className="frange">
                              <div className="frange-label">{label}</div>
                              <div className="frange-inputs">
                                <span className="frange-in">
                                  <input type="number" placeholder="Min" value={f[minK] ?? ''} onChange={num(minK)} />
                                  {unit && <i>{unit}</i>}
                                </span>
                                <span className="frange-in">
                                  <input type="number" placeholder="Max" value={f[maxK] ?? ''} onChange={num(maxK)} />
                                  {unit && <i>{unit}</i>}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="hint">Snipers and bundlers only apply once a data source reports them.</div>
              </>
            )}
            {(type === 'callers' || type === 'trending') && (
              <div className="fsec">
                <div className="fsec-title">Window</div>
                <div className="fchips">
                  {(type === 'callers' ? (['24h', '7d', '30d'] as const) : (['5m', '1h', '6h', '24h'] as const)).map((w) => (
                    <button key={w} className={`fchip${win === w ? ' on' : ''}`} onClick={() => setWin(w)}>
                      {w}
                    </button>
                  ))}
                </div>
                {type === 'trending' && <div className="hint">The column header switches windows too; this is the one it opens on.</div>}
              </div>
            )}
            {(view === 'calls' || view === 'chat') && (
              <div className="fsec">
                <div className="fsec-title">Alert</div>
                <label className="check">
                  <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Play a sound when a new call lands in this column
                </label>
                <div className="fchips">
                  {SOUNDS.map((s) => (
                    <button key={s} className={`fchip${sound === s ? ' on' : ''}`} onClick={() => { setSound(s); playSound(s, { force: true }); }} title={`use “${s}”`}>
                      <Icon name="play" size={9} /> {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="fed-foot">
          {filtersActive(f) && (
            <button className="fed-link" onClick={() => setF({})}>
              clear filters
            </button>
          )}
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={(isPlugin && !pluginId) || (isVampy && !feed)} title={isPlugin && !pluginId ? 'pick a plugin first' : isVampy && !feed ? 'pick a feed first' : undefined} onClick={save}>
            {col ? 'Update column' : 'Add column'}
          </button>
        </div>
      </div>
    </div>
  );
}
