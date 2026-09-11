import { useState } from 'react';
import type { MaskedConfig } from '../api';
import type { Status } from '../types';
import { DOCS } from '../site';
import { Logo } from './Logo';

const KEY = 'trenchfeed.bridgeNotice';

/**
 * One-time note for people who connected Discord with a token before the Vencord bridge
 * existed: their feed keeps working read-only, and switching is their call.
 */
export function BridgeNotice({ cfg, status, onOpenSettings }: { cfg: MaskedConfig; status: Status; onOpenSettings: () => void }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  });
  const relevant = cfg.discord.hasToken && status.discordMode !== 'bridge';
  if (dismissed || !relevant) return null;
  const close = () => {
    setDismissed(true);
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <div className="modal notice-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="notice-head">
          <Logo source="discord" size={16} /> <b>Discord changed in this update</b>
        </div>
        <div className="notice-body">
          <p>
            Your Discord feed still works exactly as before, using the token you saved. It is now <b>read-only</b>: sending messages and reactions with a token is gone, because
            that is the part of a self-bot Discord bans for.
          </p>
          <p>
            To send again, and to stop using a token at all, switch to the <b>opentrench plugin for Vencord</b>. It runs inside your own Discord app, so to Discord it is just you.
            One-time setup, about five minutes, Mac and Windows guides included. Nothing changes until you decide to.
          </p>
        </div>
        <div className="notice-actions">
          <a className="btn primary" href={DOCS.discordBridge} target="_blank" rel="noreferrer" onClick={close}>
            Show me how
          </a>
          <button
            onClick={() => {
              close();
              onOpenSettings();
            }}
          >
            Open Settings
          </button>
          <button onClick={close}>Later</button>
        </div>
      </div>
    </div>
  );
}
