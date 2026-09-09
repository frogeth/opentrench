import { useEffect, useState } from 'react';
import { api, type MaskedConfig } from '../api';
import type { Status } from '../types';
import { Logo } from './Logo';

type Tab = 'accounts' | 'feed' | 'trading';

/** The one settings place: a modal with three tabs. Channels are managed in the sidebar, not here. */
export function Settings({
  status,
  onClose,
  chatOrder,
  onChatOrder,
}: {
  status: Status;
  onClose: () => void;
  chatOrder: 'bottom' | 'top';
  onChatOrder: (o: 'bottom' | 'top') => void;
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
              <FavoritesSection cfg={cfg} onChange={reload} />
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
      {err && <div className="err">{err}</div>}
    </section>
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
