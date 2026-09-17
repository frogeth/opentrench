import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { PluginInfo } from '../types';

/**
 * What every plugin can do, said before what this one asked for. The clause about site logins is left
 * out when the plugin declares no sites — there would be no list above it to point at.
 */
const warning = (hasSites: boolean): string =>
  `This is code written by someone else. Once enabled it can post anything into your feed${hasSites ? ', and it can use your logins on the sites listed above through this app' : ''}. opentrench cannot check it for you. Open the file and read it before you trust it.`;

/**
 * Each permission in the user's own words. Nothing here promises less than the permission allows:
 * `actions` says "open buys for you to confirm", never "press Buy for you" — a buy is always the
 * user's own click on the confirmation bar.
 */
const PERMISSION_WORDS: Record<string, string> = {
  'feed:write': 'post messages into your feed',
  storage: 'keep its own settings and data',
  actions: 'write your clipboard, and open buys for you to confirm',
};
const host = (site: string): string => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * The last thing between a file on disk and code running against the user's feed and logins. It is a
 * modal of its own so it can scroll a long file, keep its own errors, and be dismissed without taking
 * the Settings window with it — and so the approval is bound to the exact bytes it displayed.
 */
export function PluginApproveDialog({ plugin, onClose, onApproved }: { plugin: PluginInfo; onClose: () => void; onApproved: () => void }) {
  const manifest = plugin.manifest!;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [codeErr, setCodeErr] = useState<string | null>(null);
  const [loadingCode, setLoadingCode] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  // Escape belongs to the dialog while it is open: caught in the capture phase so the Settings
  // window's own Escape handler never sees it and closes underneath.
  useEffect(() => {
    const returnTo = document.activeElement as HTMLElement | null;
    dialog.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      returnTo?.focus?.();
    };
  }, [onClose]);
  const viewCode = () => {
    if (code !== null) {
      setCode(null);
      return;
    }
    setLoadingCode(true);
    setCodeErr(null);
    api.pluginSource(plugin.id).then(
      (text) => {
        setCode(text);
        setLoadingCode(false);
      },
      (e: unknown) => {
        setCodeErr(why(e));
        setLoadingCode(false);
      },
    );
  };
  const approve = async () => {
    setBusy(true);
    setErr(null);
    try {
      // the hash of the version on screen: a file swapped while this was open is refused, not approved
      await api.pluginApprove(plugin.id, plugin.hash);
      await api.pluginEnable(plugin.id);
      onApproved();
    } catch (e: unknown) {
      setErr(why(e));
    } finally {
      setBusy(false);
    }
  };
  const words = manifest.permissions.map((p) => PERMISSION_WORDS[p] ?? p);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal plugin-approve" role="dialog" aria-modal="true" aria-labelledby="plugin-approve-title" tabIndex={-1} ref={dialog}>
        <div className="modal-head">
          <b id="plugin-approve-title">Approve {manifest.name}?</b>
          <button className="close" onClick={onClose}>
            close
          </button>
        </div>
        <div className="plugin-approve-body">
          <p>
            <b>Version</b> {manifest.version} · <b>file</b> {plugin.file} · <b>hash</b> <code>{plugin.hash.slice(0, 12)}</code>{' '}
            <button className="link" disabled={loadingCode} onClick={viewCode}>
              {loadingCode ? 'loading…' : code === null ? 'view code' : 'hide code'}
            </button>
          </p>
          {codeErr && <p className="err">could not read the file: {codeErr}</p>}
          {code !== null && <pre className="plugin-code">{code}</pre>}
          <p>
            <b>Every plugin can</b> read every message in your feed (never the ones the feed hides) and fetch any host.
          </p>
          <p>
            <b>It also asks to:</b> {words.join('; ') || 'nothing more'}.
          </p>
          {manifest.sites.length > 0 && (
            <p>
              <b>It will use your login on:</b> {manifest.sites.map(host).join(', ')}
            </p>
          )}
          <p className="err">{warning(manifest.sites.length > 0)}</p>
          {err && <p className="err plugin-approve-err">{err}</p>}
        </div>
        <div className="modal-foot">
          <button onClick={onClose}>cancel</button>
          <button className="primary" disabled={busy} onClick={approve}>
            I read it — approve and enable
          </button>
        </div>
      </div>
    </div>
  );
}
