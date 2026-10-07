/** What the desktop shell exposes to the page (electron/preload.js). Absent in a browser tab. */
export type DiscordMod = 'vencord' | 'betterdiscord';
export const DISCORD_MOD_NAMES: Record<DiscordMod, string> = { vencord: 'Vencord', betterdiscord: 'BetterDiscord' };
export interface DiscordInstallStatus {
  id: string;
  name: string;
  path: string;
  /** a client mod is injected */
  injected: boolean;
  /** which one (absent from shells older than the BetterDiscord option, where it is always Vencord) */
  mod?: DiscordMod | null;
  /** …and the opentrench plugin is in it */
  ours: boolean;
  running: boolean;
}
export interface DiscordSetupStatus {
  /** this build ships the plugin */
  available: boolean;
  version?: string;
  /** which client mods this build can install (absent from older shells: Vencord only) */
  mods?: Record<DiscordMod, boolean>;
  installs: DiscordInstallStatus[];
  reason?: string;
}
export interface DiscordSetupResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  install?: string;
  /** the client mod it went in with (absent from older shells: Vencord) */
  mod?: DiscordMod;
  /** an existing client mod was replaced */
  replaced?: boolean;
  /** …namely this one */
  replacedMod?: DiscordMod;
  nothing?: boolean;
}
export interface DesktopBridge {
  discordStatus(): Promise<DiscordSetupStatus>;
  /** with no `mod`, the shell's dialog asks which client mod to use */
  discordSetup(opts?: { mod?: DiscordMod }): Promise<DiscordSetupResult>;
  discordRemove(): Promise<DiscordSetupResult>;
  version(): Promise<string>;
  checkForUpdates(): Promise<{ ok: boolean; version: string }>;
  /** the opentrench:// link the app was opened with, handed over once; undefined when there was none */
  pendingLink(): Promise<string | undefined>;
  /** later opentrench:// links while the page is up; returns the unsubscribe */
  onLink(cb: (url: string) => void): () => void;
}

declare global {
  interface Window {
    desktop?: DesktopBridge;
  }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.desktop : undefined;

/**
 * The page is served by the backend and can be newer than the desktop shell around it (the shell
 * only changes with an app update). A bridge call that this shell does not have yet must never
 * throw into a render: check for it, and fall back.
 */
export const hasBridge = <K extends keyof DesktopBridge>(name: K): boolean => typeof desktop?.[name] === 'function';
