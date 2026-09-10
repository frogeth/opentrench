import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BotMessage } from '../types';
import { api } from '../api';
import { RichText } from './RichText';
import { Icon } from './Icon';

export const COVE_BOT = 'cove_trading_bot';

/**
 * The conversation with a Telegram bot, rendered in the app: the bot's panels
 * with their inline keyboards (pressable), your own messages, and a box to type.
 */
export function CoveView({
  bot,
  msgs,
  connected,
  onLoaded,
}: {
  bot: string;
  msgs: BotMessage[];
  connected: boolean;
  /** history fetched: merge into the live list */
  onLoaded: (bot: string, msgs: BotMessage[]) => void;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [toast, setToast] = useState<string | null>(null);
  const [pressing, setPressing] = useState<string | null>(null);
  const body = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!connected) return;
    setState('loading');
    api
      .botHistory(bot)
      .then((h) => {
        onLoaded(bot, h);
        setState('ready');
      })
      .catch((e) => {
        setErr(e?.message ?? String(e));
        setState('error');
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot, connected]);
  useLayoutEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs]);
  const flash = (t: string) => {
    setToast(t);
    window.setTimeout(() => setToast(null), 4000);
  };
  const press = async (m: BotMessage, b: { text: string; data?: string; url?: string }) => {
    if (b.url) {
      window.open(b.url, '_blank', 'noopener');
      return;
    }
    if (!b.data) return;
    const k = `${m.id}:${b.text}`;
    setPressing(k);
    try {
      const r = await api.botPress(bot, m.id, b.data);
      if (r.gone) {
        flash('That message was already closed.');
        return;
      }
      if (r.url) window.open(r.url, '_blank', 'noopener');
      if (r.message) flash(r.message);
    } catch (e: any) {
      flash(e?.message ?? 'press failed');
    } finally {
      setPressing(null);
    }
  };
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    try {
      await api.botSend(bot, t);
    } catch (e: any) {
      flash(e?.message ?? 'send failed');
    }
  };

  return (
    <div className="cove">
      <div className="cove-body" ref={body}>
        {!connected && <div className="empty">Telegram isn't connected. Cove runs through your Telegram account (⚙ → Accounts).</div>}
        {connected && state === 'loading' && msgs.length === 0 && <div className="empty">Loading your Cove conversation…</div>}
        {state === 'error' && <div className="empty err">{err}</div>}
        {connected && state === 'ready' && msgs.length === 0 && <div className="empty">Nothing yet. Press a buy button on any call, or type a command below.</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`bmsg${m.out ? ' bmsg-out' : ''}`}>
            <div className="bmsg-text">
              {m.text ? <RichText text={m.text} /> : m.hasMedia ? <span className="muted">📎 media</span> : null}
            </div>
            {m.buttons.length > 0 && (
              <div className="bkeys">
                {m.buttons.map((row, i) => (
                  <div key={i} className="bkey-row">
                    {row.map((b, j) => (
                      <button key={j} className={`bkey${b.url ? ' bkey-url' : ''}`} disabled={pressing === `${m.id}:${b.text}`} onClick={() => void press(m, b)} title={b.url ?? 'press'}>
                        {b.text}
                        {b.url && <Icon name="explorer" size={10} />}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            )}
            <div className="bmsg-time">
              {new Date(m.ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
              {m.edited && ' · updated'}
            </div>
          </div>
        ))}
      </div>
      {toast && <div className="cove-toast">{toast}</div>}
      <div className="composer cove-composer">
        <div className="composer-row">
          <textarea
            rows={1}
            value={text}
            disabled={!connected}
            placeholder={connected ? `Message @${bot} (e.g. /start, /settings)` : 'connect Telegram first'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <button className="composer-send" disabled={!connected || !text.trim()} onClick={() => void send()} title="send (Enter)">
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
