import { useEffect, useState } from 'react';
import { api, type BotSeen, type MaskedConfig } from '../api';
import type { Status } from '../types';
import { Logo } from './Logo';
import { Avatar } from './Avatar';

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
  chartProvider: 'basedbot' | 'dexscreener';
  onChartProvider: (p: 'basedbot' | 'dexscreener') => void;
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
                  <button className={chartProvider === 'basedbot' ? 'active' : ''} onClick={() => onChartProvider('basedbot')}>
                    BasedBot
                  </button>
                  <button className={chartProvider === 'dexscreener' ? 'active' : ''} onClick={() => onChartProvider('dexscreener')}>
                    Dexscreener / GeckoTerminal
                  </button>
                </div>
                <div className="hint">BasedBot needs the token's chain to be known; until then the Dexscreener chart is used.</div>
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
  const [token, setToken] = useState('');
  const [edit, setEdit] = useState(!cfg.discord.hasToken);
  const { busy, err, run } = useAsync();
  return (
    <section>
      <h2>
        <Logo source="discord" size={14} /> Discord <StatePill state={status.discord} />
      </h2>
      {!edit ? (
        <div className="row-inline">
          <span className="hint">Token saved · {cfg.discord.watch.length} channel(s) in feed</span>
          <button onClick={() => setEdit(true)}>Change token</button>
        </div>
      ) : (
        <>
          <div className="hint">Your Discord user token: DevTools → Network → any request → Authorization header.</div>
          <input type="password" placeholder="user token" value={token} onChange={(e) => setToken(e.target.value)} />
          <div className="row-inline">
            <button
              className="primary"
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
              Save &amp; connect
            </button>
            {cfg.discord.hasToken && <button onClick={() => setEdit(false)}>Cancel</button>}
          </div>
        </>
      )}
      {cfg.discord.hasToken && <DiscordSendToggle cfg={cfg} onChange={onChange} />}
      {err && <div className="err">{err}</div>}
    </section>
  );
}

/** Sending on Discord is the risky half of using a user token: off by default, typed acknowledgement to enable. */
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
            opentrench reads Discord with your own account token, which Discord's terms forbid. Reading is rarely noticed. <b>Sending is different:</b> posting through a
            token is exactly what Discord's automation checks look for, and accounts do get banned for it — sometimes without warning and with no appeal.
          </p>
          <p>
            The app limits you to one message a second per channel and only ever sends what you typed, but that does not make it allowed. If this account matters to
            you, keep this off or use an alt.
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
  return (
    <section>
      <h2>Buy buttons (Cove)</h2>
      <div className="hint">
        One-click buys open t.me/cove_trading_bot with the token and amount prefilled. Referral credit goes to your
        logged-in Telegram account automatically.
      </div>
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
  const [name, setName] = useState('');
  const { busy, err, run } = useAsync();
  return (
    <section>
      <h2>Favorite callers &amp; pings</h2>
      <div className="hint">
        Favorites get a 👑 and ping you when they post a contract nobody has called yet: a desktop notification
        (enable with the 🔔 in the top bar) and a message to your own Telegram Saved Messages. Use ⋯ next to any name
        in the feed, or add here.
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
      <div className="row-inline">
        <input placeholder="add a caller name" value={name} onChange={(e) => setName(e.target.value)} />
        <button
          disabled={busy || !name.trim()}
          onClick={() =>
            run(async () => {
              await api.favoriteToggle(name.trim());
              setName('');
              onChange();
            })
          }
        >
          Add
        </button>
      </div>
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
      <div className="hint">
        {hide ? 'Bots are hidden unless you turn them on below.' : 'Bots show unless you turn them off below.'} Shown bots
        count as callers; hidden ones only feed links into tokens.
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
