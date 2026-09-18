import { useEffect, useRef, useState } from 'react';
import { api, type BotSeen, type MarketStatus, type MaskedConfig, type RelayProbe, type RoomInfo, type TogetherInfo } from '../api';
import type { PluginInfo, Status } from '../types';
import type { SettingField } from '../plugins/route';
import { PluginsSection } from './PluginsSection';
import { Logo } from './Logo';
import { Icon, type IconName } from './Icon';
import { Avatar } from './Avatar';
import { DOCS } from '../site';
import { PeoplePicker } from './PeoplePicker';
import { CHART_PROVIDERS, copyText, type ChartProvider } from '../format';
import { desktop, hasBridge } from '../desktop';

/** Enter in a one-line form does what its button does (when the button would be enabled). */
const onEnter = (enabled: boolean, fn: () => void) => (e: React.KeyboardEvent<HTMLInputElement>) => {
  if (e.key === 'Enter' && enabled) {
    e.preventDefault();
    fn();
  }
};


type Tab = 'accounts' | 'feed' | 'market' | 'trading' | 'together' | 'plugins';
const TABS: { id: Tab; label: string; icon: IconName; title: string; blurb: string }[] = [
  { id: 'accounts', label: 'Accounts', icon: 'people', title: 'Accounts', blurb: 'Discord, Telegram and J7: what the feed reads from' },
  { id: 'feed', label: 'Feed', icon: 'chat', title: 'Feed', blurb: 'How chats and calls are shown, who pings you, which bots count' },
  { id: 'market', label: 'Market data', icon: 'live', title: 'Market data', blurb: 'Live on-chain prices: your RPCs and Alchemy key' },
  { id: 'trading', label: 'Trading', icon: 'wallet', title: 'Trading', blurb: 'Buy buttons, the mint wallet and launchpad keys' },
  { id: 'together', label: 'Together', icon: 'globe', title: 'TrenchTogether', blurb: 'Private rooms for your calls: friends join with one link, from anywhere' },
  { id: 'plugins', label: 'Plugins', icon: 'plug', title: 'Plugins', blurb: 'Custom feeds and columns from JavaScript files' },
];

/** The one settings place: a modal with a tab each. Channels are managed in the sidebar, not here. */
export function Settings({
  status,
  onClose,
  chatOrder,
  onChatOrder,
  autoChart,
  onAutoChart,
  compactEmbeds,
  onCompactEmbeds,
  chartProvider,
  onChartProvider,
  onShowSetup,
  plugins,
  pluginErrors,
  pluginSchemas,
  onPluginsChanged,
  initialTab,
  initialInvite,
}: {
  status: Status;
  onClose: () => void;
  chatOrder: 'bottom' | 'top';
  onChatOrder: (o: 'bottom' | 'top') => void;
  autoChart: boolean;
  onAutoChart: (on: boolean) => void;
  compactEmbeds: boolean;
  onCompactEmbeds: (on: boolean) => void;
  chartProvider: ChartProvider;
  onChartProvider: (p: ChartProvider) => void;
  /** reopen the first-run checklist */
  onShowSetup?: () => void;
  plugins: PluginInfo[];
  /** a plugin's last runtime error, by id */
  pluginErrors: Record<string, string>;
  /** the settings form each plugin declared, by id */
  pluginSchemas: Record<string, SettingField[]>;
  /** re-read the plugin list after something in the Plugins tab changed it */
  onPluginsChanged: () => void;
  /** the tab to open on (a deep link opens Together) */
  initialTab?: Tab;
  /** an opentrench://room/… invite the app was opened with, to fill in on the Together tab */
  initialInvite?: string;
}) {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [tab, setTab] = useState<Tab>(initialTab ?? 'accounts');
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    (hasBridge('version') ? desktop!.version() : fetch('/api/version').then((r) => r.json()).then((j) => String(j.version))).then(setVersion).catch(() => {});
  }, []);
  const reload = () => api.config().then(setCfg).catch(() => {});
  useEffect(() => {
    reload();
  }, [status.discord, status.telegram]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-settings">
        <nav className="settings-nav">
          <div className="settings-nav-label">Settings</div>
          {TABS.map((t) => (
            <button key={t.id} className={`settings-nav-item${tab === t.id ? ' active' : ''}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={15} />
              {t.label}
            </button>
          ))}
          <div className="settings-nav-foot">
            {version && <span className="muted">opentrench v{version}</span>}
            {hasBridge('checkForUpdates') && (
              <button className="link" onClick={() => void desktop!.checkForUpdates()} title="ask GitHub for a newer build now">
                check for updates
              </button>
            )}
          </div>
        </nav>
        <div className="settings-page">
          <button className="settings-close" onClick={onClose} aria-label="close settings">
            <Icon name="close" size={16} />
          </button>
          <div className="settings-title">
            <h1>{TABS.find((t) => t.id === tab)?.title}</h1>
            <div className="hint">{TABS.find((t) => t.id === tab)?.blurb}</div>
          </div>
        <div className="settings">
          {!cfg && <div className="hint">Loading…</div>}
          {cfg && tab === 'accounts' && (
            <>
              {onShowSetup && (
                <div className="hint settings-setup-link">
                  New here?{' '}
                  <button className="link" onClick={onShowSetup}>
                    open the setup guide
                  </button>
                </div>
              )}
              <DiscordAccount cfg={cfg} status={status} onChange={reload} />
              <TelegramAccount cfg={cfg} status={status} onChange={reload} />
              <J7Section cfg={cfg} status={status} onChange={reload} />
            </>
          )}
          {cfg && tab === 'feed' && (
            <>
              <section>
                <h2>Chat order</h2>
                <div className="hint">Calls always show the newest call on top. This only affects the Chats panel.</div>
                <div className="choice-grid">
                  <Choice active={chatOrder === 'bottom'} title="Newest at bottom" sub="like Discord" onClick={() => onChatOrder('bottom')} />
                  <Choice active={chatOrder === 'top'} title="Newest on top" sub="the latest message first" onClick={() => onChatOrder('top')} />
                </div>
              </section>
              <section>
                <h2>Chart provider</h2>
                <div className="choice-grid">
                  {CHART_PROVIDERS.map((p) => (
                    <Choice key={p.id} active={chartProvider === p.id} title={p.label} onClick={() => onChartProvider(p.id)} />
                  ))}
                </div>
                <div className="hint">
                  BasedBot, Birdeye and GMGN need the token's chain to be known and cover Solana, Ethereum, Base, BNB, Arbitrum and Robinhood Chain; anything else falls back to the Dexscreener chart. A cold chart can take up to half a minute to draw.
                </div>
              </section>
              <section>
                <h2>Live charts in chat</h2>
                <label className="check">
                  <input type="checkbox" checked={autoChart} onChange={(e) => onAutoChart(e.target.checked)} /> Open the
                  live chart under every contract in Chats (only loads while on screen)
                </label>
                <div className="hint">Off keeps chats compact: every contract gets a ▾ chart bar that opens its chart on demand, and ▴ folds it back.</div>
              </section>
              <section>
                <h2>Bot embeds</h2>
                <label className="check">
                  <input type="checkbox" checked={compactEmbeds} onChange={(e) => onCompactEmbeds(e.target.checked)} /> Collapse
                  call-bot cards (Captain Hook, Rick…) to one line; click the chevron to expand one
                </label>
                <div className="hint">The call card under the message already shows the token's numbers and holder data.</div>
              </section>
              <FavoritesSection cfg={cfg} onChange={reload} />
              <BotsSection cfg={cfg} onChange={reload} />
              <BlacklistSection cfg={cfg} onChange={reload} />
            </>
          )}
          {cfg && tab === 'market' && <MarketDataSection onChange={reload} />}
          {cfg && tab === 'together' && <TogetherSection status={status} initialInvite={initialInvite} />}
          {cfg && tab === 'plugins' && <PluginsSection plugins={plugins} errors={pluginErrors} schemas={pluginSchemas} onChanged={onPluginsChanged} />}
          {cfg && tab === 'trading' && (
            <>
              <CoveSection cfg={cfg} onChange={reload} />
              <OpenSeaSection onChange={reload} />
              <LaunchpadSection cfg={cfg} onChange={reload} />
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** one option in a grid of cards, the picked one outlined in the accent with a check */
function Choice({ active, title, sub, onClick }: { active: boolean; title: string; sub?: string; onClick: () => void }) {
  return (
    <button className={`choice${active ? ' active' : ''}`} onClick={onClick} aria-pressed={active}>
      <span className="choice-title">{title}</span>
      {sub && <span className="choice-sub">{sub}</span>}
      {active && <span className="choice-check" aria-hidden />}
    </button>
  );
}

function useAsync() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e: any) {
      setErr(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, err, run };
}

function StatePill({ state }: { state: string }) {
  return <span className={`pill pill-${state}`}>{state.replace('_', ' ')}</span>;
}

function DiscordAccount({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const bridge = status.discordMode === 'bridge';
  const { busy, err, run } = useAsync();
  const [setupMsg, setSetupMsg] = useState<string | null>(null);
  const setupDiscord = () =>
    run(async () => {
      setSetupMsg(null);
      const r = await desktop!.discordSetup();
      if (r.cancelled) return;
      if (!r.ok) throw new Error(r.error ?? 'setup failed');
      setSetupMsg(`Installed into ${r.install}${r.replaced ? ' (your existing Vencord was replaced by this copy; settings and plugins kept)' : ''}. Discord is restarting.`);
      onChange();
    });
  return (
    <section>
      <h2>
        <Logo source="discord" size={14} /> Discord <StatePill state={status.discord} />
        {status.discord === 'connected' && <span className="pill pill-mode">{bridge ? 'plugin · read + write' : 'token · read only'}</span>}
      </h2>

      <div className={`acct-card${bridge ? ' acct-card-on' : ''}`}>
        <div className="acct-card-title">
          <b>opentrench plugin for Vencord</b> <span className="muted">recommended · reads and sends · no token</span>
        </div>
        {bridge ? (
          <div className="hint">
            Connected through your Discord app{status.discordUser ? ` as ${status.discordUser}` : ''} · {cfg.discord.watch.length} channel(s) in feed.
            {hasBridge('discordRemove') && (
              <>
                {' '}
                <button className="link" disabled={busy} onClick={() => run(async () => { const r = await desktop!.discordRemove(); if (!r.ok && !r.cancelled) throw new Error(r.error ?? 'failed'); })}>
                  remove the plugin
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            <div className="hint">
              A small plugin inside <b>your own Discord app</b> feeds opentrench and sends for you, so to Discord it is just you using Discord. No token is stored. Discord has to
              be open for this side of the feed to work.
            </div>
            {hasBridge('discordSetup') ? (
              <>
                <div className="row-inline">
                  <button className="primary" disabled={busy} onClick={() => void setupDiscord()}>
                    {busy ? 'Setting up…' : 'Set up Discord'}
                  </button>
                  <span className="hint">Quits Discord, installs the plugin, reopens it. The pill turns green on its own once it connects.</span>
                </div>
                {setupMsg && <div className="hint">{setupMsg}</div>}
                <div className="hint">
                  Prefer to do it by hand?{' '}
                  <a href={DOCS.discordBridge} target="_blank" rel="noreferrer">
                    Step-by-step guide (Mac &amp; Windows)
                  </a>
                </div>
              </>
            ) : (
              <div className="row-inline">
                <a className="btn primary" href={DOCS.discordBridge} target="_blank" rel="noreferrer">
                  Step-by-step guide (Mac &amp; Windows)
                </a>
                <span className="hint">This pill turns green on its own once the plugin connects.</span>
              </div>
            )}
          </>
        )}
      </div>

      {bridge ? <DiscordSendToggle cfg={cfg} onChange={onChange} /> : <div className="hint">Sending on Discord needs the plugin.</div>}
      {err && <div className="err">{err}</div>}
    </section>
  );
}

/** Sending on Discord: off by default, typed acknowledgement to enable (automation from your account, even through the client). */
function DiscordSendToggle({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const [warn, setWarn] = useState(false);
  const [ack, setAck] = useState('');
  const { busy, err, run } = useAsync();
  const on = cfg.discord.canSend;
  return (
    <div className="send-toggle">
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          disabled={busy}
          onChange={(e) => {
            if (e.target.checked) setWarn(true);
            else
              void run(async () => {
                await api.setDiscordSend(false);
                onChange();
              });
          }}
        />{' '}
        Send messages and replies from opentrench
      </label>
      <div className="hint">{on ? 'On. A composer sits under every chat column; the app never sends anything you did not type.' : 'Off. Chat columns are read-only on Discord.'}</div>
      {warn && (
        <div className="send-warn">
          <b>Before you turn this on</b>
          <p>
            Messages go out through your own Discord app via the opentrench plugin, so to Discord they look like you typing. Still, a program posting from your
            account is automation, and client mods sit outside Discord's terms. Reports for spam or repeated posts land on <b>your</b> account.
          </p>
          <p>
            The app limits you to one message a second per channel and only ever sends what you typed. If this account matters to you, think before turning this on.
          </p>
          <label>
            Type <code>I understand</code> to enable:
            <input value={ack} onChange={(e) => setAck(e.target.value)} placeholder="I understand" autoFocus />
          </label>
          <div className="row-inline">
            <button
              className="danger"
              disabled={busy || ack.trim().toLowerCase() !== 'i understand'}
              onClick={() =>
                run(async () => {
                  await api.setDiscordSend(true, ack);
                  setWarn(false);
                  setAck('');
                  onChange();
                })
              }
            >
              Enable sending on Discord
            </button>
            <button onClick={() => setWarn(false)}>Keep it off</button>
          </div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </div>
  );
}

function TelegramAccount({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [apiId, setApiId] = useState(cfg.telegram.apiId ? String(cfg.telegram.apiId) : '');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [editCreds, setEditCreds] = useState(!(cfg.telegram.apiId && cfg.telegram.hasApiHash));
  const saveCreds = () =>
    run(async () => {
      await api.setTelegramCreds(Number(apiId), apiHash);
      setApiHash('');
      setEditCreds(false);
      onChange();
    });
  const submitCode = () =>
    run(async () => {
      await api.tgCode(code);
      setCode('');
    });
  const submitPassword = () =>
    run(async () => {
      await api.tgPassword(password);
      setPassword('');
    });
  const { busy, err, run } = useAsync();
  const hasCreds = !!cfg.telegram.apiId && cfg.telegram.hasApiHash;

  return (
    <section>
      <h2>
        <Logo source="telegram" size={14} /> Telegram <StatePill state={status.telegram} />
      </h2>
      {!editCreds ? (
        <div className="row-inline">
          <span className="hint">
            API credentials saved · {cfg.telegram.watch.length} chat(s) in feed
          </span>
          <button onClick={() => setEditCreds(true)}>Change</button>
        </div>
      ) : (
        <>
          <div className="hint">
            API ID and hash from{' '}
            <a href="https://my.telegram.org/apps" target="_blank" rel="noreferrer">
              my.telegram.org/apps
            </a>{' '}
            (log in with your phone, then API development tools → Create application).
          </div>
          <input placeholder="api id" value={apiId} onChange={(e) => setApiId(e.target.value)} onKeyDown={onEnter(!busy && !!apiId && !!apiHash, () => saveCreds())} />
          <input type="password" placeholder="api hash" value={apiHash} onChange={(e) => setApiHash(e.target.value)} onKeyDown={onEnter(!busy && !!apiId && !!apiHash, () => saveCreds())} />
          <div className="row-inline">
            <button disabled={busy || !apiId || !apiHash} onClick={() => saveCreds()}>
              Save credentials
            </button>
            {hasCreds && <button onClick={() => setEditCreds(false)}>Cancel</button>}
          </div>
        </>
      )}
      {hasCreds && status.telegram === 'needs_login' && status.loginStep === 'idle' && (
        <div className="row-inline">
          <input placeholder="phone, e.g. +15551234567" value={phone} onChange={(e) => setPhone(e.target.value)} onKeyDown={onEnter(!busy && !!phone, () => run(() => api.tgStart(phone)))} />
          <button className="primary" disabled={busy || !phone} onClick={() => run(() => api.tgStart(phone))}>
            Send code
          </button>
        </div>
      )}
      {status.loginStep === 'code' && (
        <div className="row-inline">
          <input placeholder="login code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onEnter(!busy && !!code, () => submitCode())} />
          <button className="primary" disabled={busy || !code} onClick={() => submitCode()}>
            Submit code
          </button>
        </div>
      )}
      {status.loginStep === 'password' && (
        <div className="row-inline">
          <input type="password" placeholder="2FA password" value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={onEnter(!busy && !!password, () => submitPassword())} />
          <button className="primary" disabled={busy || !password} onClick={() => submitPassword()}>
            Submit password
          </button>
        </div>
      )}
      {status.telegram === 'connected' && (
        <div className="row-inline">
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.tgLogout();
                onChange();
              })
            }
          >
            Log out
          </button>
        </div>
      )}
      {status.telegram === 'connected' && (
        <div className="send-toggle">
          <label className="check">
            <input
              type="checkbox"
              checked={cfg.telegram.canSend}
              disabled={busy}
              onChange={(e) =>
                run(async () => {
                  await api.setTelegramSend(e.target.checked);
                  onChange();
                })
              }
            />{' '}
            Send messages and replies from opentrench
          </label>
          <div className="hint">Telegram allows this. A composer sits under every chat column; only what you type is sent.</div>
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function CoveSection({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const [amounts, setAmounts] = useState(cfg.cove.amounts.join(', '));
  const { busy, err, run } = useAsync();
  const provider = cfg.buy?.provider ?? 'cove';
  return (
    <section>
      <h2>Buy buttons</h2>
      <div className="hint">Which bot the buy buttons and right-click → Buy use. Either way it runs in one buy pane inside opentrench through your Telegram account.</div>
      <div className="row-inline" style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Provider</span>
        <span className="seg">
          {(['cove', 'basedbot'] as const).map((p) => (
            <button key={p} className={provider === p ? 'active' : ''} disabled={busy} onClick={() => run(async () => { await api.setBuy(p); onChange(); })}>
              {p === 'cove' ? 'Cove' : 'BasedBot'}
            </button>
          ))}
        </span>
      </div>
      {provider === 'cove' ? (
        <>
          <div className="hint">One-click amounts, prefilled in Cove.</div>
          <div className="row-inline">
            <input placeholder="amounts in USD, e.g. 25, 50, 100" value={amounts} onChange={(e) => setAmounts(e.target.value)} />
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const list = amounts
                    .split(/[,\s]+/)
                    .map(Number)
                    .filter((n) => Number.isFinite(n) && n > 0);
                  await api.setCove(list);
                  onChange();
                })
              }
            >
              Save
            </button>
          </div>
        </>
      ) : (
        <div className="hint">BasedBot opens the token in @based_eth_bot and asks the amount there.</div>
      )}
      {err && <div className="err">{err}</div>}
    </section>
  );
}

/** The NFT Mint column's signing wallet: a plain-text key on this machine, so keep it dedicated and small. */
function OpenSeaSection({ onChange }: { onChange: () => void }) {
  const [os, setOs] = useState<MaskedConfig['opensea'] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [key, setKey] = useState('');
  const [copied, setCopied] = useState(false);
  const { busy, err, run } = useAsync();
  const load = () =>
    api
      .opensea()
      .then((o) => { setOs(o); setLoadErr(null); })
      .catch((e: any) => setLoadErr(e?.message ?? String(e)));
  useEffect(() => { void load(); }, []);
  if (!os) {
    return (
      <section>
        <h2>OpenSea mint wallet</h2>
        {loadErr ? <div className="err">Could not load the mint wallet settings: {loadErr}</div> : <div className="hint">Loading…</div>}
      </section>
    );
  }
  const copyAddress = async () => {
    if (!os.walletAddress) return;
    if (await copyText(os.walletAddress)) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }
  };
  return (
    <section>
      <h2>OpenSea mint wallet</h2>
      <div className="hint">
        The NFT Mint column signs mints with this key and pays from this wallet. Use a <b>dedicated wallet</b> holding only what you mean to spend: the key is stored in plain text in config.json on this machine, and a mint is irreversible once sent.
      </div>
      {os.hasWallet && os.walletAddress && (
        <div className="row-inline">
          <span className="muted">Saved wallet</span>
          <button className="osm-wallet-chip" onClick={() => void copyAddress()} title={os.walletAddress}>
            {copied ? 'copied' : os.walletAddress}
          </button>
        </div>
      )}
      <div className="row-inline">
        <input type="password" placeholder={os.hasWallet ? 'replace with a new private key (0x…)' : 'private key (0x…)'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" />
        <button disabled={busy || !key} onClick={() => void run(async () => { setOs(await api.setOpenSeaWallet(key.trim())); setKey(''); onChange(); })}>
          Save
        </button>
        {os.hasWallet && (
          <button
            disabled={busy}
            onClick={() => {
              if (!window.confirm('Remove the mint wallet key from this app? Make sure you have it backed up.')) return;
              void run(async () => {
                setOs(await api.setOpenSeaWallet(''));
                onChange();
              });
            }}
          >
            Remove
          </button>
        )}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>Mints go through the same RPCs as live prices: your custom RPC for the chain, else Alchemy, else the public endpoint. Set them under Feed → Market data.</div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function MarketDataSection({ onChange }: { onChange: () => void }) {
  const [st, setSt] = useState<MarketStatus | undefined>();
  const [key, setKey] = useState('');
  const [rpc, setRpc] = useState<Record<string, string>>({});
  const [showRpc, setShowRpc] = useState(false);
  const { busy, err, run } = useAsync();
  const load = () =>
    api
      .market()
      .then((m) => {
        setSt(m);
        setRpc(m.rpc);
      })
      .catch(() => {});
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, []);
  if (!st) return null;
  const served = st.alchemy.chains;
  const srcLabel = (c: MarketStatus['chains'][number]) => (c.source === 'custom' ? 'custom RPC' : c.source === 'alchemy' ? 'Alchemy' : 'public RPC');
  const liveNow = st.chains.reduce((n, c) => n + (c.live ?? 0), 0);
  return (
    <section>
      <h2>Endpoints</h2>
      <div className="hint">
        Every token on your screen is priced straight from its pool every 3 seconds: Uniswap v2, v3 and v4 and Pons curves on EVM chains; pump.fun, PumpSwap, Raydium, Meteora and Orca on Solana. What a pool is quoted in is read on-chain too: stables count as a dollar, ETH, SOL and BNB come from their reference pools, and anything else (a tokenized stock, WHYPE) is priced through its own pool. Cards with a green dot are live. Off-screen tokens, liquidity, volume and 24h change still come from Dexscreener and GeckoTerminal.
        {st.visible > 0 && <> <b>{st.visible}</b> on screen, <b>{liveNow}</b> live right now.</>}
      </div>
      <div className="hint" style={{ marginTop: 8 }}>
        Public RPCs work but rate-limit. An <b>Alchemy API key</b> is used for every chain Alchemy serves; a <b>custom RPC</b> per chain beats both. These are the RPCs for everything on-chain, NFT mints included.
      </div>
      <div className="row-inline">
        <input type="password" placeholder={st.alchemy.hasKey ? 'replace the Alchemy API key' : 'Alchemy API key'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="new-password" spellCheck={false} />
        <button disabled={busy || !key.trim()} onClick={() => void run(async () => { setSt(await api.setAlchemyKey(key.trim())); setKey(''); onChange(); })}>
          {busy ? 'checking…' : 'Save'}
        </button>
        {st.alchemy.hasKey && (
          <button disabled={busy} onClick={() => void run(async () => { setSt(await api.setAlchemyKey('')); onChange(); })}>
            Remove
          </button>
        )}
      </div>
      {st.alchemy.hasKey && (
        <div className="hint">
          {st.alchemy.probing ? 'Checking which chains the key answers for…' : served.length ? <>Alchemy answers for {served.map((n) => st.chains.find((c) => c.network === n)?.name ?? n).join(', ')}.</> : st.alchemy.error ?? 'The key answered for no chain.'}
        </div>
      )}
      {err && <div className="err">{err}</div>}
      <div className="md-chains">
        {st.chains.map((c) => (
          <div className="md-chain" key={c.network}>
            <span className="md-name">{c.name}</span>
            <span className={`md-src md-src-${c.source}`} title={c.source === 'public' ? c.defaultRpc : c.source === 'custom' ? st.rpc[c.network] : 'Alchemy'}>
              {srcLabel(c)}
            </span>
            {c.lastError ? (
              <span className="md-err" title={c.lastError}>{c.lastError}</span>
            ) : c.live !== undefined || c.skipped !== undefined ? (
              <span className="md-live" title={c.reasons && Object.keys(c.reasons).length ? Object.entries(c.reasons).map(([why, n]) => `${n} × ${why}`).join('\n') : 'live: priced from the pool this tick'}>
                {c.live ?? 0} live{c.skipped ? ` · ${c.skipped} skipped` : ''}
              </span>
            ) : null}
            {showRpc && (
              <>
                <input placeholder={c.defaultRpc} value={rpc[c.network] ?? ''} onChange={(e) => setRpc((r) => ({ ...r, [c.network]: e.target.value }))} spellCheck={false} />
                <button disabled={busy} onClick={() => void run(async () => { const m = await api.setMarketRpc(c.network, rpc[c.network] ?? ''); setSt(m); setRpc(m.rpc); onChange(); })}>
                  Save
                </button>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="row-inline" style={{ marginTop: 6 }}>
        <button onClick={() => setShowRpc((v) => !v)}>{showRpc ? 'hide custom RPCs' : 'custom RPCs…'}</button>
      </div>
    </section>
  );
}

function LaunchpadSection({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const [key, setKey] = useState('');
  const { busy, err, run } = useAsync();
  return (
    <section>
      <h2>Launchpads</h2>
      <div className="hint">
        Bankr, Stonks, Pons, pump.fun and letsbonk are detected automatically. o1.exchange needs an API key (starts with
        o1_launch_).
      </div>
      <div className="row-inline">
        <input
          type="password"
          placeholder={cfg.hasO1Key ? 'o1 api key (saved)' : 'o1 api key (optional)'}
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          disabled={busy || !key}
          onClick={() =>
            run(async () => {
              await api.setO1Key(key.trim());
              setKey('');
              onChange();
            })
          }
        >
          Save
        </button>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function FavoritesSection({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const { busy, err, run } = useAsync();
  return (
    <section>
      <h2>Favorite callers &amp; pings</h2>
      <div className="hint">
        Favorites get a 👑 and ping you when they post a contract nobody has called yet: a desktop notification
        (enable with the 🔔 in the top bar) and a message to your own Telegram Saved Messages. Use ⋯ next to any name
        in the feed, or search for anyone below — including people who only chat, and members who have not posted at all.
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={cfg.pingTelegram}
          disabled={busy}
          onChange={(e) =>
            run(async () => {
              await api.setPings(e.target.checked);
              onChange();
            })
          }
        />{' '}
        Telegram Saved Messages ping
      </label>
      <PeoplePicker
        favorites={cfg.favorites}
        onToggle={async (n) => {
          await api.favoriteToggle(n);
          onChange();
        }}
      />
      <div className="chips">
        {cfg.favorites.length === 0 && <span className="hint">No favorites yet.</span>}
        {cfg.favorites.map((n) => (
          <span key={n} className="chipname">
            👑 {n}
            <button
              className="mini"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.setFavorites(cfg.favorites.filter((x) => x !== n));
                  onChange();
                })
              }
              title="remove"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function BotsSection({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const [bots, setBots] = useState<BotSeen[]>([]);
  const [name, setName] = useState('');
  const { busy, err, run } = useAsync();
  const loadBots = () => api.bots().then(setBots).catch(() => {});
  useEffect(() => {
    void loadBots();
  }, [cfg]);
  const hide = cfg.bots.default === 'hide';
  const seen = new Set(bots.map((b) => b.name.replace(/^@/, '').toLowerCase()));
  const unseenAllowed = cfg.bots.allow.filter((n) => !seen.has(n.replace(/^@/, '').toLowerCase()));
  const setShow = (n: string, show: boolean) =>
    run(async () => {
      await api.botShow(n, show);
      onChange();
    });
  const pickedCalls = !hide && cfg.bots.calls === 'allow';
  const pings = cfg.bots.pings ?? 'none';
  const setPings = (n: string, on: boolean) =>
    run(async () => {
      const pingAllow = (cfg.bots.pingAllow ?? []).filter((b) => norm(b) !== norm(n));
      if (on) pingAllow.push(n);
      await api.setBots({ ...cfg.bots, pingAllow });
      onChange();
    });
  const norm = (n: string) => n.replace(/^@/, '').toLowerCase();
  const setCalls = (n: string, on: boolean) =>
    run(async () => {
      const allow = cfg.bots.allow.filter((b) => norm(b) !== norm(n));
      if (on) allow.push(n);
      await api.setBots({ ...cfg.bots, allow });
      onChange();
    });
  return (
    <section>
      <h2>Bots</h2>
      <div className="row-inline">
        <span className="seg">
          <button
            className={hide ? 'active' : ''}
            disabled={busy}
            onClick={() => run(async () => {
              await api.setBots({ default: 'hide', allow: cfg.bots.allow });
              onChange();
            })}
          >
            Hide bots
          </button>
          <button
            className={!hide ? 'active' : ''}
            disabled={busy}
            onClick={() => run(async () => {
              await api.setBots({ default: 'show', allow: cfg.bots.allow });
              onChange();
            })}
          >
            Show bots
          </button>
        </span>
      </div>
      {!hide && (
        <div className="row-inline" style={{ marginTop: 6 }}>
          <span className="muted" style={{ fontSize: 12 }}>Calls from</span>
          <span className="seg">
            <button className={!pickedCalls ? 'active' : ''} disabled={busy} onClick={() => run(async () => { await api.setBots({ ...cfg.bots, calls: 'all' }); onChange(); })}>
              every shown bot
            </button>
            <button className={pickedCalls ? 'active' : ''} disabled={busy} onClick={() => run(async () => { await api.setBots({ ...cfg.bots, calls: 'allow' }); onChange(); })}>
              only bots I pick
            </button>
          </span>
        </div>
      )}
      <div className="row-inline" style={{ marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 12 }}>Pings from</span>
        <span className="seg">
          {(['none', 'allow', 'all'] as const).map((v) => (
            <button key={v} className={pings === v ? 'active' : ''} disabled={busy} onClick={() => run(async () => { await api.setBots({ ...cfg.bots, pings: v }); onChange(); })}>
              {v === 'none' ? 'no bots' : v === 'allow' ? 'bots I pick' : 'every bot'}
            </button>
          ))}
        </span>
      </div>
      <div className="hint">
        {hide
          ? 'Bots are hidden unless you turn them on below. Shown bots count as callers; hidden ones only feed links into tokens.'
          : pickedCalls
            ? 'Bots show in chats unless you turn them off below. Only bots marked "calls" put tokens in your Calls column; the rest just chat.'
            : 'Bots show unless you turn them off below. Shown bots count as callers; hidden ones only feed links into tokens.'}
      </div>
      <div className="botlist">
        {bots.length === 0 && unseenAllowed.length === 0 && <span className="hint">No bots seen yet.</span>}
        {bots.map((b) => (
          <div key={b.name} className={`botrow${b.hidden ? ' botrow-hidden' : ''}`}>
            <Avatar src={b.avatar} name={b.name} size={22} />
            <span className="botrow-name">
              <b>{b.name}</b>
              <span title={b.chats.join('\n')}>{b.chats.join(', ')}</span>
            </span>
            <span className="botrow-count">{b.count} posts</span>
            {pings === 'allow' && !b.hidden && (
              <button className={`mini ${b.pings ? 'on' : 'off'}`} disabled={busy} onClick={() => setPings(b.name, !b.pings)} title="may this bot ping you?">
                {b.pings ? 'pings ✓' : 'no pings'}
              </button>
            )}
            {pickedCalls && !b.hidden && (
              <button className={`mini ${b.calls ? 'on' : 'off'}`} disabled={busy} onClick={() => setCalls(b.name, !b.calls)} title="do this bot's contract posts count as calls?">
                {b.calls ? 'calls ✓' : 'no calls'}
              </button>
            )}
            <button className={`mini ${b.hidden ? 'off' : 'on'}`} disabled={busy} onClick={() => setShow(b.name, b.hidden)}>
              {b.hidden ? 'hidden' : 'shown ✓'}
            </button>
          </div>
        ))}
        {unseenAllowed.map((n) => (
          <div key={n} className="botrow">
            <Avatar name={n} size={22} />
            <span className="botrow-name">
              <b>{n}</b>
              <span>allowed, not seen yet</span>
            </span>
            <span className="botrow-count" />
            <button className="mini on" disabled={busy} onClick={() => setShow(n, false)}>
              shown ✓
            </button>
          </div>
        ))}
      </div>
      <div className="row-inline" style={{ marginTop: 8 }}>
        <input placeholder="allow a bot by name, e.g. @AlertsBot" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={busy || !name.trim()}
          onClick={() => {
            const n = name.trim();
            setName('');
            void setShow(n, true);
          }}
        >
          Allow
        </button>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function BlacklistSection({ cfg, onChange }: { cfg: MaskedConfig; onChange: () => void }) {
  const [name, setName] = useState('');
  const { busy, err, run } = useAsync();
  return (
    <section>
      <h2>Blacklisted callers</h2>
      <div className="hint">
        Hidden like bots and never counted as a call; links they post still enrich tokens. Use ⋯ next to any name in
        the feed, or add here.
      </div>
      <div className="row-inline">
        <input placeholder="name, e.g. Rick or @lanternbot" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={busy || !name.trim()}
          onClick={() =>
            run(async () => {
              await api.blacklistAdd(name.trim());
              setName('');
              onChange();
            })
          }
        >
          Add
        </button>
      </div>
      <div className="chips">
        {cfg.blacklist.length === 0 && <span className="hint">Nobody blacklisted.</span>}
        {cfg.blacklist.map((n) => (
          <span key={n} className="chipname">
            🚫 {n}
            <button
              className="mini"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.setBlacklist(cfg.blacklist.filter((x) => x !== n));
                  onChange();
                })
              }
              title="remove"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

/** J7Tracker: paste the session id its web app keeps in local storage; we read its tweet stream with it. */
function J7Section({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [token, setToken] = useState('');
  const [edit, setEdit] = useState(!cfg.j7?.hasToken);
  const { busy, err, run } = useAsync();
  const st = status.j7 ?? 'disconnected';
  return (
    <section>
      <h2>
        J7Tracker <span className={`pill pill-${st}`}>{st.replace('_', ' ')}</span>
      </h2>
      <div className="hint">
        Streams J7's tweet feed into a J7 column and links each tweet to your calls. Read-only. On j7tracker.io: DevTools → Application → Local Storage → copy the value of
        <code> sessionId</code>. Unofficial: if J7 changes their app this can stop working.
      </div>
      {status.error.j7 && <div className="err">{status.error.j7}</div>}
      {cfg.j7?.hasToken && !edit ? (
        <div className="row-inline">
          <span className="muted">session id saved</span>
          <button onClick={() => setEdit(true)}>Replace</button>
          <button
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.setJ7Token('');
                onChange();
              })
            }
          >
            Disconnect
          </button>
        </div>
      ) : (
        <div className="row-inline">
          <input type="password" placeholder="sessionId" value={token} onChange={(e) => setToken(e.target.value)} />
          <button
            className="primary"
            disabled={busy || !token.trim()}
            onClick={() =>
              run(async () => {
                await api.setJ7Token(token.trim());
                setToken('');
                setEdit(false);
                onChange();
              })
            }
          >
            Save &amp; connect
          </button>
          {cfg.j7?.hasToken && <button onClick={() => setEdit(false)}>Cancel</button>}
        </div>
      )}
      {err && <div className="err">{err}</div>}
    </section>
  );
}

type RoomLive = NonNullable<Status['together']>['rooms'][number];

/** what a room's connection state means, in plain words */
const ROOM_STATE: Record<RoomLive['state'], string> = {
  connected: 'connected',
  connecting: 'connecting…',
  disconnected: 'offline · retrying',
  'key-mismatch': 'invite changed — ask for the new one',
  'relay-too-old': 'this relay needs updating',
  'access-denied': 'relay wants an access code',
  full: 'room is full',
  'rate-limited': 'slow down · retrying',
};

/** `wss://relay.example:8443/` → `relay.example:8443`; a string that is not a URL is shown without its scheme */
const relayHost = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
  }
};

/** the socket errors that all mean "nothing answered at that address" */
const UNREACHABLE = /\b(ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET)\b/;

/** the reason next to `offline · retrying`: a bare Node error code becomes words, anything else is shown as it came */
const offlineReason = (error: string, relay: string) => (UNREACHABLE.test(error) ? `could not reach ${relayHost(relay)}` : error);

/** TrenchTogether: rooms over a relay first (friends anywhere), the same-network mode under a disclosure. */
function TogetherSection({ status, initialInvite }: { status: Status; initialInvite?: string }) {
  const [info, setInfo] = useState<TogetherInfo | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const live = status.together;
  const load = () =>
    api
      .together()
      .then((i) => {
        setInfo(i);
        setLoadErr(null);
      })
      .catch((e: any) => setLoadErr(e?.message ?? String(e)));
  useEffect(() => {
    void load();
  }, [live?.sharing, live?.peers.length, live?.rooms?.length]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  /** a room just made (or re-keyed): show it, put its invite on the clipboard and say so under the card for a moment */
  const announce = async (room: RoomInfo, copied: string, ready: string) => {
    await load();
    const ok = await copyText(room.invite);
    setNotice({ id: room.id, text: ok ? copied : ready });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice((n) => (n?.id === room.id ? null : n)), 4000);
  };
  if (!info) {
    return loadErr ? (
      <div className="row-inline">
        <span className="err">Could not load: {loadErr}</span>
        <button onClick={() => void load()}>Retry</button>
      </div>
    ) : (
      <div className="hint">Loading…</div>
    );
  }
  return (
    <>
      <RoomsSection
        info={info}
        live={live}
        notice={notice}
        onChange={load}
        onRotated={(room) => void announce(room, 'New invite copied. Send it to your friends.', 'New invite ready. Copy it and send it to your friends.')}
      />
      <CreateRoom info={info} onCreated={(room) => void announce(room, 'Invite copied. Send it to your friends.', 'Invite ready. Copy it and send it to your friends.')} />
      <JoinRoom initialInvite={initialInvite} onJoined={load} />
      <SameNetwork info={info} live={live} onInfo={setInfo} onChange={load} />
    </>
  );
}

function RoomsSection({
  info,
  live,
  notice,
  onChange,
  onRotated,
}: {
  info: TogetherInfo;
  live: Status['together'];
  notice: { id: string; text: string } | null;
  onChange: () => void;
  onRotated: (room: RoomInfo) => void;
}) {
  return (
    <section>
      <h2>Rooms</h2>
      <div className="hint">A room is a private channel for your calls. Friends join with one link, from anywhere.</div>
      {info.rooms.length === 0 && <div className="hint">No rooms yet. Create one and send the invite, or paste an invite you were given.</div>}
      {info.rooms.map((room) => (
        <RoomCard key={room.id} room={room} st={live?.rooms?.find((r) => r.id === room.id)} notice={notice?.id === room.id ? notice.text : null} onChange={onChange} onRotated={onRotated} />
      ))}
    </section>
  );
}

/** one room: what it is called, where it lives, whether it is up, and the three things you can do with it */
function RoomCard({ room, st, notice, onChange, onRotated }: { room: RoomInfo; st?: RoomLive; notice: string | null; onChange: () => void; onRotated: (room: RoomInfo) => void }) {
  const { busy, err, run } = useAsync();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const [access, setAccess] = useState('');
  /** the question shown in place of the buttons before an action that affects the whole room */
  const [ask, setAsk] = useState<'rotate' | 'leave' | null>(null);
  const state = st?.state ?? 'connecting';
  const words = state === 'disconnected' && st?.error ? `${ROOM_STATE.disconnected} · ${offlineReason(st.error, room.relay)}` : ROOM_STATE[state];
  const dot = state === 'connected' ? 'on' : state === 'connecting' || state === 'rate-limited' ? 'mid' : 'off';
  const members = st?.members ?? 0;
  const copy = async () => {
    if (await copyText(room.invite)) {
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1200);
    }
  };
  const rotate = () =>
    run(async () => {
      setAsk(null);
      const r = await api.rotateRoom(room.id);
      onRotated(r.room);
    });
  const leave = () =>
    run(async () => {
      setAsk(null);
      await api.leaveRoom(room.id);
      onChange();
    });
  const saveAccess = () =>
    run(async () => {
      await api.setRoomAccess(room.id, access.trim());
      setAccess('');
      onChange();
    });
  return (
    <div className={`room-card${state === 'connected' ? ' room-card-on' : ''}`}>
      <div className="room-main">
        <div className="room-name">
          <b>{room.name}</b>
          <span className="room-meta">{relayHost(room.relay)}</span>
        </div>
        <div className="room-meta room-state">
          <span className={`tg-dot room-dot ${dot}`} />
          {words}
          {(members > 0 || state === 'connected') && <> · {members} online</>}
          {room.hasAccess && <> · access code set</>}
        </div>
        {state === 'access-denied' && (
          <div className="row-inline room-access">
            <input aria-label="access code" placeholder="access code from whoever runs the relay" value={access} onChange={(e) => setAccess(e.target.value)} spellCheck={false} onKeyDown={onEnter(!busy && !!access.trim(), () => void saveAccess())} />
            <button disabled={busy || !access.trim()} onClick={() => void saveAccess()}>
              Save
            </button>
          </div>
        )}
      </div>
      <div className="room-actions">
        {ask ? (
          <>
            <span className="room-ask">{ask === 'rotate' ? 'Make a new invite? Everyone in the room has to join again with it.' : 'Leave this room?'}</span>
            <button className={ask === 'leave' ? 'danger' : 'primary'} disabled={busy} onClick={() => void (ask === 'rotate' ? rotate() : leave())}>
              Yes
            </button>
            <button disabled={busy} onClick={() => setAsk(null)}>
              No
            </button>
          </>
        ) : (
          <>
            <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy invite'}</button>
            <button disabled={busy} onClick={() => setAsk('rotate')} title="re-key the room: the old invite stops working">
              New invite
            </button>
            <button disabled={busy} onClick={() => setAsk('leave')}>
              Leave
            </button>
          </>
        )}
      </div>
      {notice && <div className="room-notice">{notice}</div>}
      {err && <div className="err room-err">{err}</div>}
    </div>
  );
}

function CreateRoom({ info, onCreated }: { info: TogetherInfo; onCreated: (room: RoomInfo) => void }) {
  // the last relay this machine used; there is no official one to fall back to
  const pref = info.relay;
  const [name, setName] = useState('');
  const [relay, setRelay] = useState(pref);
  const [probe, setProbe] = useState<RelayProbe | null>(null);
  const [probing, setProbing] = useState(false);
  const { busy, err, run } = useAsync();
  const check = async () => {
    setProbing(true);
    setProbe(null);
    try {
      setProbe(await api.probeRelay(relay.trim()));
    } catch (e: any) {
      setProbe({ ok: false, error: e.message ?? String(e) });
    } finally {
      setProbing(false);
    }
  };
  const canCreate = !busy && name.trim().length > 0 && relay.trim().length > 0;
  const create = () =>
    run(async () => {
      const url = relay.trim();
      // the relay typed here becomes the one new rooms go on, so next time it is already filled in
      if (url !== pref) await api.setRelay(url);
      const r = await api.createRoom(name.trim(), url);
      setName('');
      onCreated(r.room);
    });
  return (
    <section className="room-form">
      <h2>Create a room</h2>
      <label className="field">
        <span className="field-label">Room name</span>
        <input placeholder="e.g. degen circle" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter(canCreate, () => void create())} />
      </label>
      <div className="row-inline">
        <label className="field">
          <span className="field-label">Relay</span>
          <input
            placeholder="wss://your-relay.example"
            value={relay}
            spellCheck={false}
            onChange={(e) => {
              setRelay(e.target.value);
              setProbe(null);
            }}
          />
        </label>
        <button disabled={probing} onClick={() => void check()} title="ask this relay whether it is up">
          {probing ? 'Checking…' : 'Check'}
        </button>
      </div>
      {probe && (probe.ok ? <div className="probe-ok">relay v{probe.v} · {probe.rooms} room{probe.rooms === 1 ? '' : 's'}</div> : <div className="probe-err">{probe.error}</div>)}
      <details className="relay-help">
        <summary>What's a relay?</summary>
        <div className="hint">
          The server the room lives on. It passes messages between members and can't read them: everything is encrypted on your machine with a key only the invite
          carries. There is no official relay: host your own (it's one command) or use a friend's. Whoever creates the room picks the relay; the invite carries its
          address, so people who join set nothing up.{' '}
          <a href={DOCS.relay} target="_blank" rel="noreferrer">
            Host your own relay
          </a>
        </div>
      </details>
      <div className="row-inline">
        <button className="primary" disabled={!canCreate} onClick={() => void create()}>
          {busy ? 'Creating…' : 'Create'}
        </button>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

function JoinRoom({ initialInvite, onJoined }: { initialInvite?: string; onJoined: () => void }) {
  const [invite, setInvite] = useState(initialInvite ?? '');
  const [name, setName] = useState('');
  const [access, setAccess] = useState('');
  const [askAccess, setAskAccess] = useState(false);
  const { busy, err, run } = useAsync();
  const canJoin = !busy && invite.trim().length > 0;
  const join = () =>
    run(async () => {
      await api.joinRoom(invite.trim(), name.trim() || undefined, access.trim() || undefined);
      setInvite('');
      setName('');
      setAccess('');
      setAskAccess(false);
      onJoined();
    });
  return (
    <section className="room-form">
      <h2>Join a room</h2>
      <div className="row-inline">
        <input aria-label="invite link" placeholder="opentrench://room/…" value={invite} spellCheck={false} autoFocus={!!initialInvite} onChange={(e) => setInvite(e.target.value)} onKeyDown={onEnter(canJoin, () => void join())} />
        <input aria-label="room name" placeholder="name it (optional)" value={name} maxLength={40} onChange={(e) => setName(e.target.value)} onKeyDown={onEnter(canJoin, () => void join())} />
      </div>
      {askAccess ? (
        <div className="row-inline">
          <input aria-label="access code" placeholder="access code from whoever runs the relay" value={access} spellCheck={false} onChange={(e) => setAccess(e.target.value)} onKeyDown={onEnter(canJoin, () => void join())} />
        </div>
      ) : (
        <button className="link room-access-link" onClick={() => setAskAccess(true)}>
          This relay asks for an access code
        </button>
      )}
      <div className="row-inline">
        <button className="primary" disabled={!canJoin} onClick={() => void join()}>
          {busy ? 'Joining…' : 'Join'}
        </button>
        <span className="hint">The invite is the whole secret: anyone who has it can read the room.</span>
      </div>
      {err && <div className="err">{err}</div>}
    </section>
  );
}

/** The no-relay mode: share with a friend on the same Wi-Fi (or VPN), or follow theirs. Folded away unless it is in use. */
function SameNetwork({ info, live, onInfo, onChange }: { info: TogetherInfo; live: Status['together']; onInfo: (i: TogetherInfo) => void; onChange: () => void }) {
  const [name, setName] = useState(info.name);
  const [pairing, setPairing] = useState('');
  const [copied, setCopied] = useState<string | null>(null);
  const [byLink, setByLink] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);
  const { busy, err, run } = useAsync();
  useEffect(() => setName(info.name), [info.name]);
  const nearby = live?.nearby ?? [];
  const requests = live?.requests ?? [];
  const outgoing = live?.outgoing ?? [];
  const inUse = !!live?.sharing || info.peers.length > 0 || (live?.peers.length ?? 0) > 0 || nearby.length > 0 || requests.length > 0;
  const [open, setOpen] = useState(inUse);
  useEffect(() => {
    if (inUse) setOpen(true);
  }, [inUse]);
  const copy = async (s: string) => {
    if (await copyText(s)) {
      setCopied(s);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(null), 1200);
    }
  };
  const addPeer = () =>
    run(async () => {
      onInfo(await api.addPeer(pairing));
      setPairing('');
    });
  const followed = (host: string, port: number) => info.peers.some((p) => p.host === host && p.port === port);
  const asked = (host: string, port: number) => outgoing.find((o) => o.host === host && o.port === port && o.state === 'pending');
  const primary = info.pairings[0];
  return (
    <details className="lan-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>Same Wi-Fi instead (no relay, nothing leaves your network)</summary>
      <div className="lan-body">
        <div className="hint">
          Share your calls with a friend on the same Wi-Fi (or the same VPN). What travels is the call: the token, who called it where, and the market numbers your machine already
          fetched. Never a chat message. Their side shows your calls tagged <b>via {info.name || 'you'}</b>, and their machine stops asking the APIs for tokens you keep fresh.
        </div>

        {requests.length > 0 && (
          <section className="tg-requests">
            <h3>Asking to follow you</h3>
            {requests.map((r) => (
              <div key={r.id} className="tg-row tg-request">
                <span className="tg-face">👤</span>
                <span className="tg-main">
                  <b>{r.name}</b>
                  <span className="muted">
                    wants to follow your calls · code <code className="tg-code">{r.code}</code> · from {r.from}
                  </span>
                </span>
                <button className="primary" disabled={busy} onClick={() => run(async () => void (await api.answerRequest(r.id, true)))}>
                  Allow
                </button>
                <button disabled={busy} onClick={() => run(async () => void (await api.answerRequest(r.id, false)))}>
                  Ignore
                </button>
              </div>
            ))}
            <div className="hint">The code is on their screen too. If it does not match, ignore it.</div>
          </section>
        )}

        <section>
          <h3>
            Share my calls <span className={`pill ${live?.sharing ? 'pill-on' : ''}`}>{live?.sharing ? `on · ${live.clients} connected` : 'off'}</span>
          </h3>
          <div className="row-inline">
            <input placeholder="your name, as your friend will see it" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} onKeyDown={onEnter(!busy, () => run(async () => onInfo(await api.setTogether({ name }))))} />
            <button disabled={busy} onClick={() => run(async () => onInfo(await api.setTogether({ name })))}>
              Save name
            </button>
            <button className={info.share ? '' : 'primary'} disabled={busy} onClick={() => run(async () => onInfo(await api.setTogether({ share: !info.share })))}>
              {info.share ? 'Stop sharing' : 'Start sharing'}
            </button>
          </div>
          <div className="hint">
            {info.share
              ? `While sharing is on, this machine shows up by name in the Together tab of every opentrench on this network, and friends can ask to follow with one click. You approve each one here. Only port ${live?.port ?? 3211} opens on the LAN; the rest of opentrench stays on 127.0.0.1.`
              : 'Turn sharing on and friends on this network see you by name and can ask to follow. Nothing is shared until you allow someone.'}
          </div>
        </section>

        <section>
          <h3>
            Nearby <span className="pill pill-mode">{nearby.length === 0 ? 'nobody sharing yet' : `${nearby.length} sharing`}</span>
          </h3>
          {nearby.length === 0 && (
            <div className="hint">Machines with sharing on announce themselves on the network every few seconds. Ask your friend to press Start sharing, and they appear here.</div>
          )}
          {nearby.map((n) => {
            const o = asked(n.host, n.port);
            const done = followed(n.host, n.port);
            return (
              <div key={n.id} className="tg-row">
                <span className="tg-face">👤</span>
                <span className="tg-main">
                  <b>{n.name}</b>
                  <span className="muted">
                    <span className="tg-dot on" /> sharing · {n.host}
                    {n.version ? ` · v${n.version}` : ''}
                  </span>
                </span>
                {done ? (
                  <span className="pill pill-on">following</span>
                ) : o ? (
                  <span className="muted tg-wait">
                    waiting for them · your code <code className="tg-code">{o.code}</code>
                  </span>
                ) : (
                  <button className="primary" disabled={busy} onClick={() => run(async () => void (await api.followNearby(n.id)))}>
                    Connect
                  </button>
                )}
              </div>
            );
          })}
          {outgoing
            .filter((o) => o.state !== 'pending' && o.state !== 'approved')
            .map((o) => (
              <div key={o.id} className="tg-row tg-row-muted">
                <span className="tg-face">👤</span>
                <span className="tg-main">
                  <b>{o.name}</b>
                  <span className="err">{o.state === 'denied' ? 'they said no' : o.error ?? 'could not ask'}</span>
                </span>
                <button disabled={busy} onClick={() => run(async () => void (await api.forgetOutgoing(o.id)))}>
                  ✕
                </button>
              </div>
            ))}
        </section>

        <section>
          <h3>
            Following <span className="pill pill-mode">{info.peers.length}</span>
          </h3>
          {info.peers.length === 0 && <div className="hint">Nobody yet. Connect to someone under Nearby, or pair by link below.</div>}
          {info.peers.map((p) => {
            const peer = live?.peers.find((x) => x.url.includes(`${p.host.includes(':') ? `[${p.host}]` : p.host}:${p.port}`));
            const st = peer?.state ?? 'disconnected';
            return (
              <div key={`${p.host}:${p.port}`} className="tg-row">
                <span className="tg-face">👤</span>
                <span className="tg-main">
                  <b>{p.name || p.host}</b>
                  <span className="muted">
                    <span className={`tg-dot ${st === 'connected' ? 'on' : st === 'connecting' ? 'mid' : 'off'}`} /> {st === 'unauthorized' ? 'their secret changed' : st} · {p.host}:{p.port}
                    {peer?.error && st !== 'connected' ? ` · ${peer.error === 'ECONNREFUSED' ? 'refused: is sharing on over there?' : peer.error === 'ETIMEDOUT' ? 'no answer' : peer.error}` : ''}
                  </span>
                </span>
                {st !== 'connected' && (
                  <button disabled={busy} onClick={() => run(async () => void (await api.reconnectPeers()))}>
                    Reconnect
                  </button>
                )}
                <button disabled={busy} onClick={() => run(async () => onInfo(await api.removePeer(p.host, p.port)))}>
                  Unfollow
                </button>
              </div>
            );
          })}
          <div className="hint">Their calls appear in your feed with a small <b>via</b> tag.</div>
        </section>

        <section>
          <button className="hdr-toggle" onClick={() => setByLink((v) => !v)}>
            {byLink ? '▾' : '▸'} Pair by link instead (not on the same network, or broadcast blocked)
          </button>
          {byLink && (
            <>
              {info.share && primary && (
                <>
                  <div className="hint">Send your friend this. Anyone with it can read your calls; rotate the secret to cut everyone off.</div>
                  <div className="row-inline pairing-row">
                    <code className="pairing">{primary}</code>
                    <button onClick={() => void copy(primary)}>{copied === primary ? 'Copied' : 'Copy'}</button>
                  </div>
                  {info.pairings.length > 1 && (
                    <details className="tg-more">
                      <summary className="hint">Other addresses of this machine ({info.pairings.length - 1})</summary>
                      {info.pairings.slice(1).map((p) => (
                        <div key={p} className="row-inline pairing-row">
                          <code className="pairing">{p}</code>
                          <button onClick={() => void copy(p)}>{copied === p ? 'Copied' : 'Copy'}</button>
                        </div>
                      ))}
                    </details>
                  )}
                  <div className="row-inline">
                    <button disabled={busy} onClick={() => run(async () => { await api.rotateTogether(); onChange(); })}>
                      Rotate the secret
                    </button>
                  </div>
                </>
              )}
              {info.share && !primary && <div className="hint">No network address found. Are you connected to Wi-Fi or Ethernet?</div>}
              <div className="row-inline">
                <input placeholder="opentrench://together/…" value={pairing} onChange={(e) => setPairing(e.target.value)} spellCheck={false} onKeyDown={onEnter(!busy && pairing.trim().length > 0, addPeer)} />
                <button className="primary" disabled={busy || !pairing.trim()} onClick={addPeer}>
                  Follow
                </button>
              </div>
            </>
          )}
        </section>
        {err && <div className="err">{err}</div>}
      </div>
    </details>
  );
}
