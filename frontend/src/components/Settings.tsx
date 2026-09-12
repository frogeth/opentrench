import { useEffect, useState } from 'react';
import { api, type BotSeen, type MaskedConfig } from '../api';
import type { Status } from '../types';
import { Logo } from './Logo';
import { Avatar } from './Avatar';
import { DOCS } from '../site';
import { PeoplePicker } from './PeoplePicker';
import { CHART_PROVIDERS, copyText, type ChartProvider } from '../format';

type Tab = 'accounts' | 'feed' | 'trading';

/** The one settings place: a modal with three tabs. Channels are managed in the sidebar, not here. */
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
}) {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const [tab, setTab] = useState<Tab>('accounts');
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
        <div className="modal-head">
          <div className="seg">
            <button className={tab === 'accounts' ? 'active' : ''} onClick={() => setTab('accounts')}>
              Accounts
            </button>
            <button className={tab === 'feed' ? 'active' : ''} onClick={() => setTab('feed')}>
              Feed
            </button>
            <button className={tab === 'trading' ? 'active' : ''} onClick={() => setTab('trading')}>
              Trading
            </button>
          </div>
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <div className="settings">
          {!cfg && <div className="hint">Loading…</div>}
          {cfg && tab === 'accounts' && (
            <>
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
                <div className="seg">
                  <button className={chatOrder === 'bottom' ? 'active' : ''} onClick={() => onChatOrder('bottom')}>
                    Newest at bottom (like Discord)
                  </button>
                  <button className={chatOrder === 'top' ? 'active' : ''} onClick={() => onChatOrder('top')}>
                    Newest on top
                  </button>
                </div>
              </section>
              <section>
                <h2>Chart provider</h2>
                <div className="seg">
                  {CHART_PROVIDERS.map((p) => (
                    <button key={p.id} className={chartProvider === p.id ? 'active' : ''} onClick={() => onChartProvider(p.id)}>
                      {p.label}
                    </button>
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
  const [token, setToken] = useState('');
  const [edit, setEdit] = useState(false);
  const { busy, err, run } = useAsync();
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
          <div className="hint">Connected through your Discord app{status.discordUser ? ` as ${status.discordUser}` : ''} · {cfg.discord.watch.length} channel(s) in feed.</div>
        ) : (
          <>
            <div className="hint">
              A small plugin inside <b>your own Discord app</b> feeds opentrench and sends for you, so to Discord it is just you using Discord. No token is stored. Discord has to
              be open for this side of the feed to work.
            </div>
            <div className="row-inline">
              <a className="btn primary" href={DOCS.discordBridge} target="_blank" rel="noreferrer">
                Step-by-step guide (Mac &amp; Windows)
              </a>
              <span className="hint">This pill turns green on its own once the plugin connects.</span>
            </div>
          </>
        )}
      </div>

      <div className={`acct-card${!bridge && cfg.discord.hasToken ? ' acct-card-on' : ''}`}>
        <div className="acct-card-title">
          <b>User token</b> <span className="muted">legacy · read only · self-bot risk</span>
        </div>
        {cfg.discord.hasToken && !edit ? (
          <div className="row-inline">
            <span className="hint">{bridge ? 'Saved, unused while the plugin is connected.' : `Reading ${cfg.discord.watch.length} channel(s). Sending is off on this path.`}</span>
            <button onClick={() => setEdit(true)}>Change</button>
            <button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  await api.setDiscordToken('');
                  onChange();
                })
              }
            >
              Remove token
            </button>
          </div>
        ) : edit || !cfg.discord.hasToken ? (
          <>
            <div className="hint">
              Only if you can't run the plugin. Discord's terms forbid this and accounts have been banned for it; reading is quieter than sending, which is why sending was
              removed here. Token: DevTools → Network → any request → Authorization header.
            </div>
            <div className="row-inline">
              <input type="password" placeholder="user token" value={token} onChange={(e) => setToken(e.target.value)} />
              <button
                disabled={busy || !token}
                onClick={() =>
                  run(async () => {
                    await api.setDiscordToken(token);
                    setToken('');
                    setEdit(false);
                    onChange();
                  })
                }
              >
                Save
              </button>
              {cfg.discord.hasToken && <button onClick={() => setEdit(false)}>Cancel</button>}
            </div>
          </>
        ) : null}
      </div>

      {bridge ? <DiscordSendToggle cfg={cfg} onChange={onChange} /> : <div className="hint">Sending on Discord needs the plugin. With a token, chat columns are read-only.</div>}
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
          <div className="hint">API ID and hash from my.telegram.org → API development tools.</div>
          <input placeholder="api id" value={apiId} onChange={(e) => setApiId(e.target.value)} />
          <input type="password" placeholder="api hash" value={apiHash} onChange={(e) => setApiHash(e.target.value)} />
          <div className="row-inline">
            <button
              disabled={busy || !apiId || !apiHash}
              onClick={() =>
                run(async () => {
                  await api.setTelegramCreds(Number(apiId), apiHash);
                  setApiHash('');
                  setEditCreds(false);
                  onChange();
                })
              }
            >
              Save credentials
            </button>
            {hasCreds && <button onClick={() => setEditCreds(false)}>Cancel</button>}
          </div>
        </>
      )}
      {hasCreds && status.telegram === 'needs_login' && status.loginStep === 'idle' && (
        <div className="row-inline">
          <input placeholder="phone, e.g. +15551234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="primary" disabled={busy || !phone} onClick={() => run(() => api.tgStart(phone))}>
            Send code
          </button>
        </div>
      )}
      {status.loginStep === 'code' && (
        <div className="row-inline">
          <input placeholder="login code" value={code} onChange={(e) => setCode(e.target.value)} />
          <button
            className="primary"
            disabled={busy || !code}
            onClick={() =>
              run(async () => {
                await api.tgCode(code);
                setCode('');
              })
            }
          >
            Submit code
          </button>
        </div>
      )}
      {status.loginStep === 'password' && (
        <div className="row-inline">
          <input type="password" placeholder="2FA password" value={password} onChange={(e) => setPassword(e.target.value)} />
          <button
            className="primary"
            disabled={busy || !password}
            onClick={() =>
              run(async () => {
                await api.tgPassword(password);
                setPassword('');
              })
            }
          >
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

/** The OpenSea Mint column's signing wallet: a plain-text key on this machine, so keep it dedicated and small. */
function OpenSeaSection({ onChange }: { onChange: () => void }) {
  const [os, setOs] = useState<MaskedConfig['opensea'] | null>(null);
  const [key, setKey] = useState('');
  const [rpc, setRpc] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const { busy, err, run } = useAsync();
  const load = () => api.opensea().then((o) => { setOs(o); setRpc(o.rpc); }).catch(() => {});
  useEffect(() => { void load(); }, []);
  if (!os) return null;
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
        The OpenSea Mint column signs mints with this key and pays from this wallet. Use a <b>dedicated wallet</b> holding only what you mean to spend: the key is stored in plain text in config.json on this machine, and a mint is irreversible once sent.
      </div>
      {os.hasWallet && os.walletAddress && (
        <div className="row-inline">
          <span className="muted">Saved wallet</span>
          <button className="mini" onClick={() => void copyAddress()} title={os.walletAddress}>
            {copied ? 'copied' : os.walletAddress}
          </button>
        </div>
      )}
      <div className="row-inline">
        <input type="password" placeholder={os.hasWallet ? 'replace with a new private key (0x…)' : 'private key (0x…)'} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" />
        <button disabled={busy || !key} onClick={() => run(async () => { setOs(await api.setOpenSeaWallet(key.trim())); setKey(''); onChange(); })}>
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
      <div className="hint" style={{ marginTop: 8 }}>RPC endpoints. Blank uses the public default.</div>
      {(os.chains ?? []).map((c) => (
        <div className="row-inline" key={c.id}>
          <span className="muted" style={{ width: 120, fontSize: 12 }}>{c.name}</span>
          <input placeholder={c.defaultRpc} value={rpc[c.id] ?? ''} onChange={(e) => setRpc((r) => ({ ...r, [c.id]: e.target.value }))} spellCheck={false} />
          <button disabled={busy} onClick={() => run(async () => { const o = await api.setOpenSeaRpc(c.id, rpc[c.id] ?? ''); setOs(o); setRpc(o.rpc); })}>
            Save
          </button>
        </div>
      ))}
      {err && <div className="err">{err}</div>}
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
