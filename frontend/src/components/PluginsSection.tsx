import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import type { SettingField } from '../plugins/route';
import { DOCS } from '../site';
import type { PluginInfo } from '../types';
import { Icon } from './Icon';
import { PluginApproveDialog } from './PluginApproveDialog';

const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const host = (site: string): string => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

/**
 * The settings a plugin asked the user for, as the form its `ot.settings.schema` describes. The form
 * comes from the running plugin when there is one and from the backend's copy otherwise, so a plugin
 * that is switched off — or waiting to be approved — can still have its key filled in.
 */
function SettingsForm({ id, fields }: { id: string; fields?: SettingField[] }) {
  const [schema, setSchema] = useState<SettingField[]>(fields ?? []);
  const [values, setValues] = useState<Record<string, unknown> | null>(null);
  const [state, setState] = useState<'clean' | 'dirty' | 'saved'>('clean');
  const [err, setErr] = useState<string | null>(null);
  // A plugin re-declaring the same form on every start hands us a new array each time; only a form
  // that actually differs may reload the values and throw away what the user has half typed.
  const fieldsKey = JSON.stringify(fields ?? []);
  useEffect(() => {
    let live = true;
    setValues(null);
    api.pluginSettings(id).then(
      (r) => {
        if (!live) return;
        // the running plugin's form wins; the stored one fills in for a plugin that is not running
        const form = fields?.length ? fields : r.schema;
        setSchema(form);
        // a field the user has never touched shows the plugin's default, and saves as one
        const seeded: Record<string, unknown> = { ...r.values };
        for (const f of form) if (!(f.key in seeded) && f.default !== undefined) seeded[f.key] = f.default;
        setValues(seeded);
      },
      () => live && setValues({}),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, fieldsKey]);
  if (schema.length === 0) return null;
  if (!values) return <div className="hint">Loading settings…</div>;
  const set = (key: string, v: unknown) => {
    setValues((s) => ({ ...s, [key]: v }));
    setState('dirty');
    setErr(null);
  };
  const save = () =>
    api.pluginSettingsSet(id, values).then(
      () => setState('saved'),
      (e: unknown) => setErr(why(e)),
    );
  return (
    <div className="plugin-settings">
      {schema.map((f) => {
        const v = values[f.key];
        return (
          <label key={f.key} className="plugin-field">
            <span>{f.label}</span>
            {f.type === 'toggle' ? (
              <input type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} />
            ) : (
              <input
                className="fed-input"
                // a secret is stored beside the plugin's other settings; the field only keeps it off the screen
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
      {/* until plugin secrets are sealed the way the app's own are, say plainly where they end up */}
      <div className="hint">stored in plain text in your plugins state file</div>
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
  /** the settings form each running plugin declared, by id */
  schemas: Record<string, SettingField[]>;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<string | null>(null);
  const [logs, setLogs] = useState<{ ts: number; level: string; text: string }[]>([]);
  const [shell, setShell] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    setNote(null); // whatever was last added is no longer what just happened
    try {
      await fn();
      onChanged();
    } catch (e: unknown) {
      setErr(why(e));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    setLogs([]); // the panel must never show one plugin's lines under another's name
    if (!logsFor) return;
    const load = () => api.pluginLogs(logsFor).then(setLogs, () => {});
    load();
    const t = window.setInterval(load, 3000);
    return () => window.clearInterval(t);
  }, [logsFor]);
  // a plugin removed (or gone from the folder) takes its open log panel with it
  useEffect(() => {
    if (logsFor && !plugins.some((p) => p.id === logsFor)) setLogsFor(null);
  }, [plugins, logsFor]);
  // Only worth saying when a plugin actually wants a site: without the desktop app its sign-in button
  // has nothing to open. Keyed on that one boolean, not on the list: `plugins` is a fresh array on
  // every server event, and this asked the backend again on each of them.
  const wantsSites = plugins.some((p) => (p.manifest?.sites.length ?? 0) > 0);
  useEffect(() => {
    if (!wantsSites) return;
    api.pluginsShell().then(
      (s) => setShell(s.available),
      () => {},
    );
  }, [wantsSites]);

  /**
   * Installing says what landed, because a replacement is the case that matters: the file the user
   * approved before is gone, and the new one starts unapproved.
   */
  const landed = (info: PluginInfo & { replaced: boolean }) => {
    const name = info.manifest?.name ?? info.id;
    setNote(info.replaced ? `replaced ${name}; it needs approval again` : `added ${name} ${info.manifest?.version ?? ''} — review & approve`.trim());
    onChanged();
  };
  /** the plugin this id would overwrite, if the user already has one under it */
  const installed = (id: string | undefined) => (id ? plugins.find((p) => p.id === id) : undefined);
  const okToReplace = (name: string) => window.confirm(`Replace the installed ${name}? Its approval is reset.`);
  const addFile = async (f: File) => {
    // the same file picked twice in a row must still fire a change event
    if (fileInput.current) fileInput.current.value = '';
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      // what the file *is* decides what it would replace, so its manifest is read first; `inspect`
      // writes nothing, and an unreadable file is refused here rather than half-installed
      const source = await f.text();
      const had = installed((await api.pluginInspect(source)).id);
      if (had && !okToReplace(had.manifest?.name ?? had.id)) return;
      landed(await api.pluginAdd(source));
    } catch (e: unknown) {
      setErr(why(e));
    } finally {
      setBusy(false);
    }
  };
  const addUrl = async () => {
    const link = url.trim();
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      // What is behind a link is only known once the backend has fetched it: a 409 here means the
      // file's own id names a plugin already installed, and the same call goes back naming the id the
      // user confirmed — so a second download that has become something else is refused, not written.
      let info: PluginInfo & { replaced: boolean };
      try {
        info = await api.pluginAddUrl(link);
      } catch (e: unknown) {
        const clash = e instanceof ApiError && e.status === 409 && typeof e.data.replaces === 'string' ? e.data.replaces : null;
        if (!clash) throw e;
        if (!okToReplace(installed(clash)?.manifest?.name ?? clash)) return;
        info = await api.pluginAddUrl(link, clash);
      }
      landed(info);
      setUrl(''); // …and a link that did not install stays in the box to be fixed
    } catch (e: unknown) {
      setErr(why(e));
    } finally {
      setBusy(false);
    }
  };
  const pending = approving ? plugins.find((p) => p.id === approving) : undefined;
  return (
    <div className="plugins">
      <div className="hint">
        Plugins are single JavaScript files in your <b>plugins</b> folder. Each runs in its own sandbox and only reaches the app through the plugin API.{' '}
        <a href={DOCS.plugins} target="_blank" rel="noreferrer">
          How to write one ↗
        </a>
      </div>
      <div className="plugins-add">
        {/* a real button, so the control is reachable by keyboard; the input itself stays hidden */}
        <button className="seen-all" disabled={busy} onClick={() => fileInput.current?.click()}>
          add a file
        </button>
        <input ref={fileInput} type="file" accept=".js" hidden onChange={(e) => e.target.files?.[0] && void addFile(e.target.files[0])} />
        <input className="fed-input" placeholder="or paste an https link to a .js file" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button className="seen-all" disabled={busy || !/^https:\/\//.test(url.trim())} onClick={() => void addUrl()}>
          add from link
        </button>
        <button className="seen-all" disabled={busy} onClick={() => run(() => api.pluginsReload())}>
          reload folder
        </button>
      </div>
      {err && <div className="empty err">{err}</div>}
      {note && <div className="hint plugin-note">{note}</div>}
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
          </div>
          {/* what the file is wrong about, and what it did wrong while running: both said in full */}
          {p.error && <div className="err plugin-err">{p.error}</div>}
          {errors[p.id] && <div className="err plugin-err">{errors[p.id]}</div>}
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
              <button className="seen-all" onClick={() => setApproving(p.id)}>
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
          {p.manifest && <SettingsForm id={p.id} fields={schemas[p.id]} />}
          {logsFor === p.id && <pre className="plugin-log">{logs.length === 0 ? 'nothing logged yet' : logs.map((l) => `${new Date(l.ts).toLocaleTimeString()} ${l.level} ${l.text}`).join('\n')}</pre>}
        </div>
      ))}
      {pending?.manifest && pending.needsApproval && (
        <PluginApproveDialog
          // a rescan gives the same plugin new bytes: a fresh dialog, with the old code pane gone
          key={pending.hash}
          plugin={pending}
          onClose={() => setApproving(null)}
          onApproved={() => {
            setApproving(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}
