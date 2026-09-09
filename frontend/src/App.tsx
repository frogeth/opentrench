import { useState } from 'react';
import { useFeed } from './useFeed';
import { Feed } from './components/Feed';
import { Settings } from './components/Settings';
import type { Status } from './types';

function Pill({ label, state }: { label: string; state: string }) {
  return (
    <span className={`pill pill-${state}`}>
      {label}: {state.replace('_', ' ')}
    </span>
  );
}

export default function App() {
  const { messages, tokens, status, wsOpen } = useFeed();
  const [open, setOpen] = useState(false);
  const errors = Object.entries(status.error) as [keyof Status['error'], string][];

  return (
    <div className="app">
      <header>
        <h1>trenchfeed</h1>
        <Pill label="discord" state={status.discord} />
        <Pill label="telegram" state={status.telegram} />
        {!wsOpen && <span className="pill pill-disconnected">server: offline</span>}
        <button className="gear" onClick={() => setOpen((o) => !o)} title="settings">
          ⚙
        </button>
      </header>
      {errors.length > 0 && (
        <div className="banner" onClick={() => setOpen(true)}>
          {errors.map(([k, v]) => (
            <div key={k}>
              <b>{k}:</b> {v}
            </div>
          ))}
        </div>
      )}
      <main>
        <Feed messages={messages} tokens={tokens} />
        {open && <Settings status={status} onClose={() => setOpen(false)} />}
      </main>
    </div>
  );
}
