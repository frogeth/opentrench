import { useEffect, useLayoutEffect, useRef, useState, useContext } from 'react';
import type { BotMessage } from '../types';
import { api } from '../api';
import { useSlashMenu } from './SlashMenu';
import { RichText, LinkInterceptContext } from './RichText';
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
  onForward,
}: {
  bot: string;
  msgs: BotMessage[];
  connected: boolean;
  /** history fetched: merge into the live list */
  onLoaded: (bot: string, msgs: BotMessage[]) => void;
  /** send one of the bot's messages (a report) to a chat in the feed */
  onForward?: (bot: string, m: BotMessage) => void;
}) {
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [err, setErr] = useState<string | null>(null);
  const [text, setText] = useState('');
  // the bot's slash commands: typing "/" lists them, Enter or a click sends the one picked
  const slash = useSlashMenu({
    text,
    setText,
    cacheKey: bot,
    enabled: connected,
    load: () => api.botCommands(bot).then((list) => list.map((c) => ({ name: c.command, description: c.description, fill: `/${c.command}` }))),
    onPick: (item) => {
      api.botSend(bot, item.fill).catch((e: any) => flash(e?.message ?? 'send failed'));
    },
  });
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
  // Cove's own deep links (positions, Sell 100%, Move, Hide, bulk sell, buy confirms…) run in-app
  const outer = useContext(LinkInterceptContext); // the app's router, for links to other bots and chats
  const intercept = (href: string) => {
    const m = new RegExp(`^(?:https?://t\\.me/${bot}/?\\?start=|tg://resolve\\?domain=${bot}&start=)([A-Za-z0-9_-]+)`, 'i').exec(href);
    if (!m) return !!outer?.(href);
    void api.botStart(bot, m[1]).catch((err) => flash(err?.message ?? 'failed'));
    return true;
  };
  const press = async (m: BotMessage, b: { text: string; data?: string; url?: string }) => {
    if (b.url) {
      if (!intercept(b.url)) window.open(b.url, '_blank', 'noopener');
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
      if (r.url && !intercept(r.url)) window.open(r.url, '_blank', 'noopener');
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
    <LinkInterceptContext.Provider value={intercept}>
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
              {onForward && !m.out && (m.text || m.hasMedia) && (
                <button className="row-reply bmsg-fwd" onClick={() => onForward(bot, m)} title="send this to a chat (Discord or Telegram)" aria-label="forward">
                  <Icon name="forward" size={12} /> send to chat
                </button>
              )}
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
              if (slash.onKeyDown(e)) return;
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          {slash.menu}
          <button className="composer-send" disabled={!connected || !text.trim()} onClick={() => void send()} title="send (Enter)">
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </div>
    </LinkInterceptContext.Provider>
  );
}
