import { useMemo, useState } from 'react';
import type { ColumnDef, ColumnFilters, DiscordChannel, WatchedChat } from '../api';
import { Avatar } from './Avatar';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { SOUNDS, playSound } from '../sounds';
import { filtersActive } from '../filters';

export const chatKey = (w: { source: string; id: string }) => `${w.source}:${w.id}`;

const CHAINS: [string, string][] = [
  ['solana', 'Solana'], ['ethereum', 'Ethereum'], ['base', 'Base'], ['bsc', 'BSC'], ['robinhood', 'Robinhood'],
  ['hyperevm', 'HyperEVM'], ['arbitrum', 'Arbitrum'], ['monad', 'Monad'], ['blast', 'Blast'], ['avalanche', 'Avalanche'],
];
const LAUNCHPADS: [string, string][] = [
  ['pumpfun', 'Pump.fun'], ['letsbonk', 'letsbonk'], ['bankr', 'Bankr'], ['stonks', 'Stonks'], ['pons', 'Pons'],
  ['o1', 'o1'], ['virtuals', 'Virtuals'], ['flap', 'Flap'], ['clanker', 'Clanker'],
];
const MUST: [string, string][] = [
  ['website', 'Website'], ['twitter', 'Twitter'], ['telegram', 'Telegram'], ['social', '≥1 social'], ['image', 'Image'], ['devSold', 'Dev sold'], ['lpLocked', 'LP locked'],
];
type NumKey = { [K in keyof ColumnFilters]-?: NonNullable<ColumnFilters[K]> extends number ? K : never }[keyof ColumnFilters];
const RANGES: { title: string; rows: [string, NumKey, NumKey, string][] }[] = [
  { title: 'Metrics', rows: [['Market cap', 'mcMin', 'mcMax', '$'], ['Liquidity', 'liqMin', 'liqMax', '$'], ['Volume 24h', 'volMin', 'volMax', '$'], ['MC / Liq', 'mcLiqMin', 'mcLiqMax', 'x'], ['Multiplier', 'multMin', 'multMax', 'x']] },
  { title: 'Activity', rows: [['Holders', 'holdersMin', 'holdersMax', ''], ['Age', 'ageMin', 'ageMax', 'min'], ['Txns 24h', 'txMin', 'txMax', ''], ['Buys', 'buysMin', 'buysMax', ''], ['Sells', 'sellsMin', 'sellsMax', ''], ['Times called', 'callsMin', 'callsMax', '']] },
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
  onSave,
  onClose,
}: {
  col?: ColumnDef;
  watched: WatchedChat[];
  channels?: DiscordChannel[];
  /** names seen in the feed, for the caller pickers */
  callers?: string[];
  onSave: (c: ColumnDef) => void;
  onClose: () => void;
}) {
  const [type, setType] = useState<ColumnDef['type']>(col?.type ?? 'chat');
  const [title, setTitle] = useState(col?.title ?? '');
  const [chats, setChats] = useState<string[]>(col?.chats ?? []);
  const [win, setWin] = useState<NonNullable<ColumnDef['window']>>(col?.window ?? '7d');
  const [alertOn, setAlertOn] = useState(col?.alert?.on ?? false);
  const [sound, setSound] = useState(col?.alert?.sound ?? 'ping');
  const [f, setF] = useState<ColumnFilters>(col?.filters ?? {});
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const set = <K extends keyof ColumnFilters>(k: K, v: ColumnFilters[K]) => setF((s) => ({ ...s, [k]: v }));
  const num = (k: NumKey) => (e: React.ChangeEvent<HTMLInputElement>) => set(k, e.target.value === '' ? undefined : Number(e.target.value));
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

  // Group by Discord server, channels under their category, Telegram at the end.
  const groups = useMemo(() => {
    const cat = new Map(channels.map((c) => [c.id, c.category]));
    const m = new Map<string, { source: 'discord' | 'telegram'; avatar?: string; items: { w: WatchedChat; category?: string }[] }>();
    for (const w of watched) {
      const server = w.source === 'discord' ? (/\(([^)]*)\)\s*$/.exec(w.name)?.[1] ?? 'Discord') : 'Telegram';
      const g = m.get(server) ?? { source: w.source, avatar: undefined, items: [] };
      if (!g.avatar && w.avatar && w.source === 'discord') g.avatar = w.avatar;
      g.items.push({ w, category: w.source === 'discord' ? cat.get(w.id) : undefined });
      m.set(server, g);
    }
    return [...m.entries()].sort((a, b) => (a[0] === 'Telegram' ? 1 : b[0] === 'Telegram' ? -1 : a[0].localeCompare(b[0])));
  }, [watched, channels]);
  const shortName = (w: WatchedChat) => (w.source === 'discord' ? w.name.replace(/\s*\([^)]*\)\s*$/, '').replace(/^#/, '') : w.name);
  const groupState = (items: { w: WatchedChat }[]) => {
    const n = items.filter(({ w }) => selected.includes(chatKey(w))).length;
    return n === 0 ? 'none' : n === items.length ? 'all' : 'some';
  };
  const toggleGroup = (items: { w: WatchedChat }[]) => {
    const keys = items.map(({ w }) => chatKey(w));
    commit(groupState(items) === 'all' ? selected.filter((k) => !keys.includes(k)) : [...new Set([...selected, ...keys])]);
  };

  const save = () => {
    const t = title.trim() || (type === 'calls' ? (all ? 'All Calls' : 'Calls') : type === 'callers' ? 'Top Callers' : all ? 'All Chats' : 'Chats');
    if (none && watched.length > 0 && !window.confirm('No channels are selected, so this column will stay empty. Save anyway?')) return;
    const clean: ColumnFilters = {};
    for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== false && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'string' && !v.trim())) (clean as any)[k] = v;
    onSave({
      ...(col ?? {}),
      id: col?.id ?? `c${Date.now().toString(36)}`,
      type,
      title: t,
      chats,
      ...(type === 'callers' ? { window: win } : {}),
      ...(type !== 'callers' ? { alert: { on: alertOn, sound } } : {}),
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
              {(['chat', 'calls', 'callers'] as const).map((t) => (
                <button key={t} className={type === t ? 'active' : ''} onClick={() => setType(t)}>
                  <Icon name={t === 'chat' ? 'chat' : t === 'calls' ? 'calls' : 'people'} size={13} /> {t === 'chat' ? 'Messages' : t === 'calls' ? 'Calls' : 'Top Callers'}
                </button>
              ))}
            </div>
            <div className="fed-label">Feed name</div>
            <input className="fed-input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={type === 'calls' ? 'All Calls' : type === 'callers' ? 'Top Callers' : 'All Chats'} maxLength={40} />
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
              {groups.map(([server, g]) => {
                const st = groupState(g.items);
                const isOpen = open[server] ?? false;
                let lastCat: string | undefined;
                return (
                  <div key={server} className="ftree-group">
                    <div className="ftree-head">
                      <button className="ftree-arrow" onClick={() => setOpen((o) => ({ ...o, [server]: !isOpen }))} aria-label={isOpen ? 'collapse' : 'expand'}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                      <input type="checkbox" checked={st === 'all'} ref={(el) => el && (el.indeterminate = st === 'some')} onChange={() => toggleGroup(g.items)} />
                      {g.avatar ? <Avatar src={g.avatar} name={server} size={18} /> : <Logo source={g.source} size={14} />}
                      <b onClick={() => setOpen((o) => ({ ...o, [server]: !isOpen }))}>{server}</b>
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
                              {w.source === 'discord' ? <span className="muted">#</span> : w.avatar ? <Avatar src={w.avatar} name={w.name} size={14} /> : <Logo source="telegram" size={12} />}
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
          </div>

          {/* ---------- right: filters & alerts ---------- */}
          <div className="fed-right">
            {type === 'chat' && (
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
                  </div>
                </div>
              </>
            )}
            {type !== 'callers' && (
              <>
                <NameList title="Show only" hint={type === 'calls' ? 'Only calls by these callers' : 'Only messages from these callers'} value={f.showOnly ?? []} onChange={(v) => set('showOnly', v)} suggestions={callers} />
                <NameList title="Muted callers" hint={type === 'calls' ? 'Hide calls by these callers' : 'Hide messages from these callers'} value={f.muted ?? []} onChange={(v) => set('muted', v)} suggestions={callers} />
              </>
            )}
            {type === 'calls' && (
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
            {type === 'callers' && (
              <div className="fsec">
                <div className="fsec-title">Window</div>
                <div className="fchips">
                  {(['24h', '7d', '30d'] as const).map((w) => (
                    <button key={w} className={`fchip${win === w ? ' on' : ''}`} onClick={() => setWin(w)}>
                      {w}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {type !== 'callers' && (
              <div className="fsec">
                <div className="fsec-title">Alert</div>
                <label className="check">
                  <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} /> Play a sound when a new call lands in this column
                </label>
                <div className="fchips">
                  {SOUNDS.map((s) => (
                    <button key={s} className={`fchip${sound === s ? ' on' : ''}`} onClick={() => { setSound(s); playSound(s); }} title={`use “${s}”`}>
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
          <button className="primary" onClick={save}>
            {col ? 'Update column' : 'Add column'}
          </button>
        </div>
      </div>
    </div>
  );
}
