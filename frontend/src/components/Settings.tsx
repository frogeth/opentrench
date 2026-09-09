import { useEffect, useState } from 'react';
import { api, type DiscordChannel, type MaskedConfig, type TelegramDialog } from '../api';
import type { Status } from '../types';

export function Settings({ status, onClose }: { status: Status; onClose: () => void }) {
  const [cfg, setCfg] = useState<MaskedConfig | null>(null);
  const reload = () => api.config().then(setCfg).catch(() => {});
  useEffect(() => {
    reload();
  }, [status.discord, status.telegram]);

  return (
    <aside className="settings">
      <button className="close" onClick={onClose}>
        close
      </button>
      {cfg && <DiscordSection cfg={cfg} status={status} onChange={reload} />}
      {cfg && <TelegramSection cfg={cfg} status={status} onChange={reload} />}
    </aside>
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

function DiscordSection({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [token, setToken] = useState('');
  const [channels, setChannels] = useState<DiscordChannel[]>([]);
  const [search, setSearch] = useState('');
  const { busy, err, run } = useAsync();

  useEffect(() => {
    if (status.discord === 'connected') api.discordChannels().then(setChannels).catch(() => {});
  }, [status.discord]);

  const toggle = (id: string) =>
    run(async () => {
      const next = cfg.discord.watch.includes(id)
        ? cfg.discord.watch.filter((x) => x !== id)
        : [...cfg.discord.watch, id];
      await api.setDiscordWatch(next);
      onChange();
    });

  const q = search.toLowerCase();
  const shown = channels.filter(
    (c) => !q || c.name.toLowerCase().includes(q) || c.guildName.toLowerCase().includes(q),
  );
  const groups = new Map<string, DiscordChannel[]>();
  for (const c of shown) {
    if (!groups.has(c.guildName)) groups.set(c.guildName, []);
    groups.get(c.guildName)!.push(c);
  }

  return (
    <section>
      <h2>Discord</h2>
      <div className="hint">
        {cfg.discord.hasToken
          ? 'Token saved.'
          : 'Paste your Discord user token (DevTools → Network → any request → Authorization header).'}
      </div>
      <input type="password" placeholder="user token" value={token} onChange={(e) => setToken(e.target.value)} />
      <button
        className="primary"
        disabled={busy || !token}
        onClick={() =>
          run(async () => {
            await api.setDiscordToken(token);
            setToken('');
            onChange();
          })
        }
      >
        Save token &amp; connect
      </button>
      {err && <div className="err">{err}</div>}
      {status.discord === 'connected' && (
        <>
          <input placeholder="search channels…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="picker">
            {[...groups.entries()].map(([g, chs]) => (
              <div key={g}>
                <div className="group">{g}</div>
                {chs.map((c) => (
                  <label key={c.id}>
                    <input type="checkbox" checked={cfg.discord.watch.includes(c.id)} onChange={() => toggle(c.id)} />{' '}
                    #{c.name}
                  </label>
                ))}
              </div>
            ))}
            {channels.length === 0 && <div className="hint">Waiting for channel list…</div>}
          </div>
          <div className="hint">{cfg.discord.watch.length} channel(s) watched</div>
        </>
      )}
    </section>
  );
}

function TelegramSection({ cfg, status, onChange }: { cfg: MaskedConfig; status: Status; onChange: () => void }) {
  const [apiId, setApiId] = useState(cfg.telegram.apiId ? String(cfg.telegram.apiId) : '');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [dialogs, setDialogs] = useState<TelegramDialog[]>([]);
  const [search, setSearch] = useState('');
  const { busy, err, run } = useAsync();

  useEffect(() => {
    if (status.telegram === 'connected') api.telegramDialogs().then(setDialogs).catch(() => {});
  }, [status.telegram]);

  const toggle = (id: string) =>
    run(async () => {
      const next = cfg.telegram.watch.includes(id)
        ? cfg.telegram.watch.filter((x) => x !== id)
        : [...cfg.telegram.watch, id];
      await api.setTelegramWatch(next);
      onChange();
    });

  const q = search.toLowerCase();
  const shown = dialogs.filter((d) => !q || d.title.toLowerCase().includes(q));
  const hasCreds = !!cfg.telegram.apiId && cfg.telegram.hasApiHash;

  return (
    <section>
      <h2>Telegram</h2>
      {!hasCreds && <div className="hint">Get an API ID and hash at my.telegram.org → API development tools.</div>}
      <input placeholder="api id" value={apiId} onChange={(e) => setApiId(e.target.value)} />
      <input
        type="password"
        placeholder={cfg.telegram.hasApiHash ? 'api hash (saved)' : 'api hash'}
        value={apiHash}
        onChange={(e) => setApiHash(e.target.value)}
      />
      <button
        disabled={busy || !apiId || !apiHash}
        onClick={() =>
          run(async () => {
            await api.setTelegramCreds(Number(apiId), apiHash);
            setApiHash('');
            onChange();
          })
        }
      >
        Save credentials
      </button>

      {hasCreds && status.telegram === 'needs_login' && status.loginStep === 'idle' && (
        <>
          <input placeholder="phone, e.g. +15551234567" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="primary" disabled={busy || !phone} onClick={() => run(() => api.tgStart(phone))}>
            Send code
          </button>
        </>
      )}
      {status.loginStep === 'code' && (
        <>
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
        </>
      )}
      {status.loginStep === 'password' && (
        <>
          <input
            type="password"
            placeholder="2FA password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
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
        </>
      )}
      {err && <div className="err">{err}</div>}

      {status.telegram === 'connected' && (
        <>
          <input placeholder="search chats…" value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="picker">
            {shown.map((d) => (
              <label key={d.id}>
                <input type="checkbox" checked={cfg.telegram.watch.includes(d.id)} onChange={() => toggle(d.id)} />{' '}
                {d.title} <span className="hint">({d.type})</span>
              </label>
            ))}
            {dialogs.length === 0 && <div className="hint">Loading chats…</div>}
          </div>
          <div className="hint">{cfg.telegram.watch.length} chat(s) watched</div>
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
        </>
      )}
    </section>
  );
}
