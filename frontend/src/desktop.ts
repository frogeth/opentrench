/** What the desktop shell exposes to the page (electron/preload.js). Absent in a browser tab. */
export interface DiscordInstallStatus {
  id: string;
  name: string;
  path: string;
  /** some Vencord injector is in place */
  injected: boolean;
  /** …and it is the copy opentrench installed */
  ours: boolean;
  running: boolean;
}
export interface DiscordSetupStatus {
  /** this build ships the plugin */
  available: boolean;
  version?: string;
  installs: DiscordInstallStatus[];
  reason?: string;
}
export interface DiscordSetupResult {
  ok: boolean;
  cancelled?: boolean;
  error?: string;
  install?: string;
  /** an existing Vencord was replaced by ours */
  replaced?: boolean;
  nothing?: boolean;
}
export interface DesktopBridge {
  discordStatus(): Promise<DiscordSetupStatus>;
  discordSetup(): Promise<DiscordSetupResult>;
  discordRemove(): Promise<DiscordSetupResult>;
  version(): Promise<string>;
  checkForUpdates(): Promise<{ ok: boolean; version: string }>;
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
