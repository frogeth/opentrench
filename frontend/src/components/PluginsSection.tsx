import { useEffect, useState } from 'react';
import { api } from '../api';
import type { SettingField } from '../plugins/route';
import { DOCS } from '../site';
import type { PluginInfo } from '../types';
import { Icon } from './Icon';

/** The last word before a plugin runs. Written to be read, not skimmed; it never softens. */
const WARNING =
  'This is code written by someone else. Once enabled it can post anything into your feed, and it can use your logins on the sites listed above through this app. opentrench cannot check it for you. Open the file and read it before you trust it.';

/**
 * What each permission means in the user's own words. Nothing here promises less than the permission
 * allows: `actions` says "open buys for you to confirm", never "buy" — a buy is always the user's own
 * click on the confirmation bar.
 */
const PERMISSION_WORDS: Record<string, string> = {
  'feed:write': 'post messages into your feed',
  storage: 'keep its own settings and data',
  actions: 'write your clipboard, and open buys for you to confirm',
};
const permissionWords = (permissions: string[]): string[] => permissions.map((p) => PERMISSION_WORDS[p] ?? p);
const host = (site: string): string => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

/** The settings a plugin asked the user for, as the form its `ot.settings.schema` describes. */
function SettingsForm({ id, fields }: { id: string; fields: SettingField[] }) {
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<'clean' | 'dirty' | 'saved'>('clean');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setValues(null);
    // A plugin with no settings yet reads as an empty form, not as an error.
    api.pluginSettings(id).then(
      (v) => live && setValues(v),
      () => live && setValues({}),
    );
    return () => {
      live = false;
    };
  }, [id]);
  if (!values) return <div className="hint">Loading settings…</div>;
  const set = (key: string, v: unknown) => {
    setValues((s) => ({ ...s, [key]: v }));
    setState('dirty');
    setErr(null);
  };
  const save = () =>
    api.pluginSettingsSet(id, values).then(
      () => setState('saved'),
      (e: unknown) => setErr(e instanceof Error ? e.message : String(e)),
    );
  return (
    <div className="plugin-settings">
      {fields.map((f) => {
        const v = values[f.key] ?? f.default;
        return (
          <label key={f.key} className="plugin-field">
            <span>{f.label}</span>
            {f.type === 'toggle' ? (
              <input type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} />
            ) : (
              <input
                className="fed-input"
                // a secret is still stored beside the plugin's other settings; the field only keeps it off the screen
                type={f.type === 'secret' ? 'password' : f.type === 'number' ? 'number' : 'text'}
                value={v === undefined || v === null ? '' : String(v)}
                onChange={(e) => set(f.key, f.type === 'number' ? (e.target.value === '' ? undefined : Number(e.target.value)) : e.target.value)}
              />
            )}
          </label>
        );
      })}
      <div className="plugin-actions">
        <button className="seen-all" disabled={state !== 'dirty'} onClick={save}>
          {state === 'saved' ? 'saved' : 'save settings'}
        </button>
        {err && <span className="err">{err}</span>}
      </div>
    </div>
  );
}

/**
 * ⚙ → Plugins: what is in the plugins folder, what each one may do, and the approval a plugin needs
 * before it runs at all. Everything here reads the backend's list; nothing is trusted from a plugin.
 */
export function PluginsSection({
  plugins,
  errors,
  schemas,
  onChanged,
}: {
  plugins: PluginInfo[];
  /** a plugin's last runtime error, by id (the frames report these) */
  errors: Record<string, string>;
  /** the settings form each plugin declared, by id */
  schemas: Record<string, SettingField[]>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<PluginInfo | null>(null);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ ts: number; level: string; text: string }[]>([]);
  const [code, setCode] = useState<string | null>(null);
  const [shell, setShell] = useState(true);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!logsFor) return;
    const load = () => api.pluginLogs(logsFor).then(setLogs, () => {});
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [logsFor]);
  // Only worth saying when a plugin actually wants a site: without the desktop app its sign-in button
  // has nothing to open. Asked again whenever the list changes, so plugging the app in clears the hint.
  const wantsSites = plugins.some((p) => (p.manifest?.sites.length ?? 0) > 0);
  useEffect(() => {
    if (!wantsSites) return;
    api.pluginsShell().then(
      (s) => setShell(s.available),
      () => {},
    );
  }, [wantsSites, plugins]);
  const addFile = (f: File) => f.text().then((source) => run(() => api.pluginAdd(source)));
  const viewCode = (p: PluginInfo) => (code === null ? api.pluginSource(p.id).then(setCode, (e: unknown) => setCode(e instanceof Error ? e.message : String(e))) : setCode(null));
  return (
    <div className="plugins">
      <div className="hint">
        Plugins are single JavaScript files in your <b>plugins</b> folder. Each runs in its own sandbox and only reaches the app through the plugin API.{' '}
        <a href={DOCS.plugins} target="_blank" rel="noreferrer">
          How to write one ↗
        </a>
      </div>
      <div className="plugins-add">
        <label className="seen-all">
          add a file
          <input type="file" accept=".js" hidden onChange={(e) => e.target.files?.[0] && addFile(e.target.files[0])} />
        </label>
        <input className="fed-input" placeholder="or paste an https link to a .js file" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button className="seen-all" disabled={busy || !/^https:\/\//.test(url.trim())} onClick={() => run(() => api.pluginAddUrl(url.trim()).then(() => setUrl('')))}>
          add from link
        </button>
        <button className="seen-all" disabled={busy} onClick={() => run(() => api.pluginsReload())}>
          reload folder
        </button>
      </div>
      {err && <div className="empty err">{err}</div>}
      {wantsSites && !shell && <div className="hint">Signing in to sites needs the desktop app.</div>}
      {plugins.length === 0 && <div className="empty">No plugins yet.</div>}
      {plugins.map((p) => (
        <div key={p.id} className={`plugin-row${p.enabled ? ' on' : ''}`}>
          <div className="plugin-main">
            <Icon name="plug" size={14} />
            <b>{p.manifest?.name ?? p.id}</b>
            {p.manifest && (
              <span className="muted">
                v{p.manifest.version} · api {p.manifest.api}
              </span>
            )}
            {p.error && <span className="err">{p.error}</span>}
            {errors[p.id] && (
              <span className="err" title={errors[p.id]}>
                error — see log
              </span>
            )}
          </div>
          {p.manifest && (
            <div className="plugin-meta muted">
              {p.manifest.description && <div>{p.manifest.description}</div>}
              <div>permissions: {p.manifest.permissions.join(', ') || 'none'}</div>
              {p.manifest.sites.length > 0 && (
                <div>
                  sites:{' '}
                  {p.manifest.sites.map((s) => (
                    <span key={s} className="plugin-site">
                      {host(s)}{' '}
                      {p.signedIn.includes(s) ? (
                        <span className="up">signed in</span>
                      ) : (
                        <button className="link" disabled={busy || !p.enabled} title={p.enabled ? `open ${host(s)} and sign in` : 'enable the plugin first'} onClick={() => run(() => api.pluginSignIn(p.id, s))}>
                          sign in
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              )}
              {Object.keys(p.chats).length > 0 && <div>chats: {Object.values(p.chats).join(', ')}</div>}
            </div>
          )}
          <div className="plugin-actions">
            {p.manifest && p.needsApproval && (
              <button
                className="seen-all"
                onClick={() => {
                  setCode(null);
                  setApproving(p);
                }}
              >
                review &amp; approve
              </button>
            )}
            {p.manifest && !p.needsApproval && !p.enabled && (
              <button className="seen-all" disabled={busy} onClick={() => run(() => api.pluginEnable(p.id))}>
                enable
              </button>
            )}
            {p.enabled && (
              <button className="seen-all on" disabled={busy} onClick={() => run(() => api.pluginDisable(p.id))}>
                disable
              </button>
            )}
            <button className="seen-all" onClick={() => setLogsFor(logsFor === p.id ? null : p.id)}>
              log
            </button>
            <button className="seen-all" disabled={busy} onClick={() => window.confirm(`Remove ${p.manifest?.name ?? p.id}? The file is deleted.`) && run(() => api.pluginRemove(p.id))}>
              remove
            </button>
          </div>
          {schemas[p.id]?.length > 0 && <SettingsForm id={p.id} fields={schemas[p.id]} />}
          {logsFor === p.id && <pre className="plugin-log">{logs.length === 0 ? 'nothing logged yet' : logs.map((l) => `${new Date(l.ts).toLocaleTimeString()} ${l.level} ${l.text}`).join('\n')}</pre>}
        </div>
      ))}
      {approving?.manifest && (
        <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && setApproving(null)}>
          <div className="modal plugin-approve">
            <h3>Approve {approving.manifest.name}?</h3>
            <p>
              <b>Version</b> {approving.manifest.version} · <b>file</b> {approving.file}{' '}
              <button className="link" onClick={() => viewCode(approving)}>
                {code === null ? 'view code' : 'hide code'}
              </button>
            </p>
            {code !== null && <pre className="plugin-code">{code}</pre>}
            <p>
              <b>Every plugin can</b> read every message in your feed (never the ones the feed hides) and fetch any host.
            </p>
            <p>
              <b>It also asks to:</b> {permissionWords(approving.manifest.permissions).join('; ') || 'nothing more'}.
            </p>
            {approving.manifest.sites.length > 0 && (
              <p>
                <b>It will use your login on:</b> {approving.manifest.sites.map(host).join(', ')}
              </p>
            )}
            <p className="err">{WARNING}</p>
            <div className="modal-actions">
              <button className="seen-all" onClick={() => setApproving(null)}>
                cancel
              </button>
              <button
                className="seen-all on"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.pluginApprove(approving.id);
                    await api.pluginEnable(approving.id);
                    setApproving(null);
                  })
                }
              >
                I read it — approve and enable
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
