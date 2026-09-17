import type { FeedMessage, PluginInfo, TokenInfo } from '../types';
import { PluginFrame } from './PluginFrame';
import type { PluginContext, SettingField } from './route';

/** Runs every enabled plugin that has no column of its own, out of sight. */
export function PluginHost({
  plugins,
  messages,
  tokens,
  actionsFor,
  onSchema,
  onError,
}: {
  plugins: PluginInfo[];
  messages: FeedMessage[];
  tokens: Record<string, TokenInfo>;
  /** the actions a given plugin gets: buy and copy name the plugin to the user, so each one is bound to its own */
  actionsFor: (id: string) => PluginContext['actions'];
  onSchema: (id: string, schema: SettingField[]) => void;
  onError: (id: string, text: string) => void;
}) {
  return (
    <>
      {plugins
        .filter((p) => p.enabled && p.manifest && !p.manifest.ui)
        .map((p) => (
          <PluginFrame
            key={`${p.id}:${p.hash}`}
            plugin={p}
            messages={messages}
            tokens={tokens}
            actions={actionsFor(p.id)}
            visible={false}
            onSchema={(s) => onSchema(p.id, s)}
            onError={(t) => onError(p.id, t)}
          />
        ))}
    </>
  );
}
