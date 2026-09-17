import { useState } from 'react';
import type { Status } from '../types';
import { desktop, hasBridge } from '../desktop';
import { Logo } from './Logo';

export const ONBOARDED_KEY = 'opentrench:onboarded';
const DISCORD_GUIDE = 'https://opentrench.app/docs/discord/';

/**
 * First-run checklist: Discord, Telegram, channels. Shown once when nothing is connected yet;
 * reachable again from ⚙ → Accounts → "setup guide".
 */
export function Onboarding({
  status,
  watched,
  onOpenSettings,
  onAddChats,
  onClose,
}: {
  status: Status;
  /** chats in the feed */
  watched: number;
  onOpenSettings: () => void;
  onAddChats: (source: 'discord' | 'telegram') => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const discordDone = status.discord === 'connected';
  const telegramDone = status.telegram === 'connected';
  const chatsDone = watched > 0;
  const canSetup = hasBridge('discordSetup');
  const setupDiscord = async () => {
    if (!canSetup) return;
    setBusy(true);
    setMsg(null);
    try {
      const r = await desktop!.discordSetup();
      if (r.cancelled) return;
      if (!r.ok) throw new Error(r.error ?? 'setup failed');
      setMsg(`Installed into ${r.install}. Discord is restarting; this step ticks itself when the plugin connects.`);
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal notice-modal onboard" onMouseDown={(e) => e.stopPropagation()}>
        <div className="notice-head">
          <b>Welcome to opentrench</b>
        </div>
        <div className="notice-body">
          <p>Three steps and the feed is live. Everything runs on this machine with your own accounts.</p>
          <div className="onboard-steps">
            <div className={`onboard-step${discordDone ? ' done' : ''}`}>
              <span className="onboard-num">{discordDone ? '✓' : '1'}</span>
              <span>
                <b>
                  <Logo source="discord" size={12} /> Connect Discord
                </b>
                <span className="hint">
                  {discordDone
                    ? `Connected${status.discordUser ? ` as ${status.discordUser}` : ''}.`
                    : canSetup
                      ? 'One click: opentrench installs its plugin into your Discord app and reopens it. Discord has to stay open for this side of the feed.'
                      : 'A small plugin inside your own Discord app. Five minutes, once, with the guide.'}
                </span>
              </span>
              {!discordDone &&
                (canSetup ? (
                  <button className="primary" disabled={busy} onClick={() => void setupDiscord()}>
                    {busy ? 'Setting up…' : 'Set up Discord'}
                  </button>
                ) : (
                  <a className="btn primary" href={DISCORD_GUIDE} target="_blank" rel="noreferrer">
                    Guide
                  </a>
                ))}
            </div>
            <div className={`onboard-step${telegramDone ? ' done' : ''}`}>
              <span className="onboard-num">{telegramDone ? '✓' : '2'}</span>
              <span>
                <b>
                  <Logo source="telegram" size={12} /> Connect Telegram
                </b>
                <span className="hint">{telegramDone ? 'Logged in.' : 'An API ID and hash from my.telegram.org (a minute), then your phone number and the code Telegram sends.'}</span>
              </span>
              {!telegramDone && (
                <button className="primary" onClick={onOpenSettings}>
                  Open accounts
                </button>
              )}
            </div>
            <div className={`onboard-step${chatsDone ? ' done' : ''}`}>
              <span className="onboard-num">{chatsDone ? '✓' : '3'}</span>
              <span>
                <b>Add channels</b>
                <span className="hint">{chatsDone ? `${watched} in your feed.` : 'Pick the Discord channels and Telegram chats to watch. You can preview any of them first.'}</span>
              </span>
              {!chatsDone && (
                <span className="row-inline">
                  <button onClick={() => onAddChats('discord')} disabled={!discordDone}>
                    Discord
                  </button>
                  <button onClick={() => onAddChats('telegram')} disabled={!telegramDone}>
                    Telegram
                  </button>
                </span>
              )}
            </div>
          </div>
          {msg && <div className="hint">{msg}</div>}
          <div className="onboard-foot">
            <span className="hint">Come back here any time from ⚙ → Accounts.</span>
            <button onClick={onClose}>{discordDone || telegramDone ? 'Done' : 'Skip for now'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
