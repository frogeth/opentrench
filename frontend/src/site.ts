/** Where the website and docs live. Swap this once the domain is set up. */
export const SITE_URL = 'https://opentrench.app';
export const DOCS = {
  home: SITE_URL,
  gettingStarted: `${SITE_URL}/docs/`,
  discordBridge: `${SITE_URL}/docs/discord/`,
  telegram: `${SITE_URL}/docs/telegram/`,
  /**
   * The plugin reference lives in the repo (`docs/plugins.md`) and has no page on the site yet, so
   * this points at the file itself rather than at a `/docs/plugins/` that would 404. Move it to
   * `${SITE_URL}/docs/plugins/` the day that page exists.
   */
  plugins: 'https://github.com/frogeth/opentrench/blob/main/docs/plugins.md',
} as const;
