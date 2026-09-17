// opentrench desktop: runs the backend with Electron's bundled Node and opens a window on it.
const { app, BrowserWindow, shell, nativeTheme, dialog, Menu, safeStorage, ipcMain } = require('electron');
const discordSetup = require('./discord-setup');
const stale = require('./stale');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.TRENCHFEED_PORT ?? 3210);
const URL = `http://127.0.0.1:${PORT}`;
const RELEASES_URL = 'https://github.com/frogeth/opentrench/releases/latest';
let child = null;
let win = null;

// A plain-text log next to the backend's (app.getPath('logs')): what the desktop shell prints,
// plus every renderer or helper process Chromium loses, with its reason. A Website column that
// turns into Chromium's sad page on Windows is invisible otherwise.
const LOG_MAX = 2 * 1024 * 1024;
let logFile = null;
function openLog() {
  try {
    const dir = app.getPath('logs');
    fs.mkdirSync(dir, { recursive: true });
    logFile = path.join(dir, 'desktop.log');
    try {
      if (fs.statSync(logFile).size > LOG_MAX) fs.renameSync(logFile, `${logFile}.1`);
    } catch {}
    const orig = { log: console.log.bind(console), error: console.error.bind(console) };
    const write = (level, args) => {
      const line = `${new Date().toISOString()} ${level} ${args.map((a) => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}\n`;
      try {
        fs.appendFileSync(logFile, line);
      } catch {}
    };
    console.log = (...args) => {
      orig.log(...args);
      write('INFO', args);
    };
    console.error = (...args) => {
      orig.error(...args);
      write('ERROR', args);
    };
  } catch {}
  console.log(`[desktop] opentrench ${app.getVersion()} electron ${process.versions.electron} ${process.platform} ${require('node:os').release()} ${process.arch} packaged=${app.isPackaged} exe=${process.execPath}`);
  // Chromium losing a process: a renderer (the app page or a Website column's frame) or a helper (GPU, network…)
  app.on('render-process-gone', (_e, contents, d) => console.error(`[desktop] renderer gone: ${d.reason} exit=${d.exitCode} url=${contents?.getURL?.() ?? '?'}`));
  app.on('child-process-gone', (_e, d) => console.error(`[desktop] ${d.type} process gone: ${d.reason} exit=${d.exitCode} ${d.name ?? ''} ${d.serviceName ?? ''}`));
}

function paths() {
  const packaged = app.isPackaged;
  const backendDir = packaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..', 'backend');
  const entry = path.join(backendDir, 'dist', 'index.js');
  const data = app.getPath('userData');
  // the Vencord build shipped for one-click Discord setup (scripts/build-vencord.sh)
  const vencord = packaged ? path.join(process.resourcesPath, 'vencord') : path.join(__dirname, 'resources', 'vencord');
  return { packaged, backendDir, entry, data, vencord, config: path.join(data, 'config.json'), state: path.join(data, 'state.json') };
}

/** First run: adopt the old trenchfeed app-data folder, or (from the repo) the dev checkout's files. */
function adoptDevFiles(p) {
  fs.mkdirSync(p.data, { recursive: true });
  const old = path.join(path.dirname(p.data), 'trenchfeed');
  for (const f of ['config.json', 'state.json']) {
    const to = path.join(p.data, f);
    const from = path.join(old, f);
    if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
  }
  if (p.packaged) return;
  for (const [from, to] of [
    [path.join(p.backendDir, 'config.json'), p.config],
    [path.join(p.backendDir, 'state.json'), p.state],
  ]) {
    if (!fs.existsSync(to) && fs.existsSync(from)) fs.copyFileSync(from, to);
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/status`, { timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitFor(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/**
 * What the backend on the port says it is: `{ version, managed }`, where `managed` means a desktop
 * app started it (as opposed to `node dist/index.js` from a checkout); null when it predates
 * /api/version or is unreachable.
 */
function backendVersion() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/version`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) return resolve(null);
          const j = JSON.parse(body);
          resolve({ version: String(j.version ?? ''), managed: j.managed !== false });
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

/** -1, 0, 1 for a < b, a = b, a > b over dotted numbers; anything unparsable counts as older than everything. */
function compareVersions(a, b) {
  const pa = String(a ?? '').split('.').map(Number);
  const pb = String(b ?? '').split('.').map(Number);
  if (pa.some(Number.isNaN) || !pa.length || !String(a ?? '').trim()) return -1;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** @returns false when the app should quit instead of opening a window */
async function startBackend() {
  const p = paths();
  if (await ping()) {
    // Attaching to a backend from another build is how a column type the backend has never heard
    // of silently turns into a chat column: its config parser rewrites what it doesn't know. A
    // stale `npm start` from an older checkout is the usual culprit.
    const info = await backendVersion();
    const v = info?.version ?? null;
    const cmp = compareVersions(v, app.getVersion());
    if (cmp >= 0) {
      // the same build (the usual case: a restart while the backend kept running) or a newer one
      // (a dev checkout ahead of the app): use it, nothing to ask
      console.log('[desktop] backend already running on', URL, cmp > 0 ? `(newer: ${v}) — attaching` : '— attaching');
      return true;
    }
    if (info && !info.managed) {
      // a checkout's own backend that reports an older number: usually one started before the
      // version bump, holding the developer's real config. An update must not kill it unasked.
      const { response } = await dialog.showMessageBox({
        type: 'question',
        message: `A backend run from a checkout (${v}) is on port ${PORT}`,
        detail: `This app is ${app.getVersion()}. Use that backend as it is, or stop it and start this app's own (a different config).`,
        buttons: ['Use it', 'Replace it'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 0) {
        console.log(`[desktop] attaching to the checkout backend (${v}) on ${URL} at the user's request`);
        return true;
      }
    }
    // older and started by a desktop app: one left behind by the previous version. Replace it, no questions.
    console.log(`[desktop] a backend from ${v || 'an older build'} is on port ${PORT}; this app is ${app.getVersion()} — replacing it`);
    const r = await stale.stopListener(PORT, ping, (m) => console.log('[desktop]', m));
    if (!r.ok) {
      await dialog.showMessageBox({
        type: 'error',
        message: "opentrench can't start",
        detail: 'An older copy of opentrench is still running on this computer and would not close. Quit it (check the Dock, the tray, or Task Manager for opentrench), then open opentrench again.',
        buttons: ['Quit'],
      });
      return false;
    }
    console.log('[desktop] stale backend stopped; starting our own');
  }
  adoptDevFiles(p);
  if (!fs.existsSync(p.entry)) throw new Error(`backend not built: ${p.entry}`);
  const secretKey = loadSecretKey(p.data);
  child = spawn(process.execPath, [p.entry], {
    cwd: p.backendDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(PORT),
      TRENCHFEED_CONFIG: p.config,
      TRENCHFEED_STATE: p.state,
      TRENCHFEED_PARENT_PID: String(process.pid),
      TRENCHFEED_APP_VERSION: app.getVersion(),
      ...(secretKey ? { TRENCHFEED_SECRET_KEY_STDIN: '1' } : {}),
    },
    // the key goes over stdin, not the environment: another process of the same user can list
    // a process's environment but not read its pipes
    stdio: [secretKey ? 'pipe' : 'ignore', 'pipe', 'pipe'],
  });
  if (secretKey) child.stdin.end(secretKey + '\n');
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.on('exit', (code) => {
    console.log('[desktop] backend exited', code);
    child = null;
  });
  if (!(await waitFor(20_000))) throw new Error('backend did not come up');
  return true;
}

/**
 * The key the backend seals tokens and wallet keys with. A random 32 bytes, generated once and
 * kept in `secret.key` encrypted by the OS keychain (safeStorage: Keychain on macOS, DPAPI on
 * Windows, the desktop's keyring on Linux). No keychain → no key, and the backend keeps plain
 * text as before. An unreadable existing file is never replaced: the backend leaves values sealed
 * with the old key on disk, and a fresh key would orphan them for good.
 */
function loadSecretKey(dataDir) {
  const file = path.join(dataDir, 'secret.key');
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn('[desktop] OS keychain unavailable: config secrets stay in plain text');
    return null;
  }
  if (fs.existsSync(file)) {
    try {
      const key = safeStorage.decryptString(fs.readFileSync(file)).trim();
      if (/^[0-9a-f]{64}$/i.test(key)) return key;
      console.warn('[desktop] secret.key is not a key; leaving it alone, secrets stay sealed');
    } catch (e) {
      console.warn('[desktop] cannot open secret.key with this keychain; leaving it alone, secrets stay sealed:', e.message);
    }
    return null;
  }
  const key = crypto.randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, safeStorage.encryptString(key), { mode: 0o600 });
    console.log('[desktop] created secret.key in the keychain');
    return key;
  } catch (e) {
    console.warn('[desktop] cannot store secret.key; config secrets stay in plain text:', e.message);
    return null;
  }
}

function createWindow() {
  nativeTheme.themeSource = 'dark';
  win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#0a0c0f',
    title: 'opentrench',
    ...(app.isPackaged ? {} : { icon: path.join(__dirname, 'build', 'icon.png') }),
    // macOS: the traffic lights sit inside the app's own top bar (the page pads for them);
    // Windows: the native minimize / maximize / close overlay the top bar's right edge, drawn in
    // the bar's colours; Linux keeps the system frame.
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 } }
      : process.platform === 'win32'
        ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#0a0c0f', symbolColor: '#e6e8ee', height: 40 } }
        : {}),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  // Website columns embed pages in iframes, and two things break sites there. Many refuse
  // framing with X-Frame-Options or a frame-ancestors CSP (a blank box), so those refusals are
  // dropped for sub-frame documents. And Chromium treats a cross-site frame's requests to its
  // own origin as cross-site, withholding any cookie that isn't SameSite=None, so a site's
  // session never sticks (mintgo.fun sat on "Loading…" forever): cookies set by responses to
  // requests made inside a frame are rewritten to SameSite=None; Secure. The app's own page
  // keeps every header it gets.
  win.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    if (!details.responseHeaders) return callback({});
    const inFrame = !!details.frame && details.frame !== win.webContents.mainFrame;
    const isFrameDoc = details.resourceType === 'subFrame';
    if (!inFrame && !isFrameDoc) return callback({});
    const https = /^https:/i.test(details.url);
    let changed = false;
    const headers = {};
    for (const [k, v] of Object.entries(details.responseHeaders)) {
      const key = k.toLowerCase();
      if (isFrameDoc && key === 'x-frame-options') {
        changed = true;
        continue;
      }
      if (isFrameDoc && (key === 'content-security-policy' || key === 'content-security-policy-report-only')) {
        const kept = (Array.isArray(v) ? v : [v]).map((line) => line.split(';').filter((d) => !/^\s*frame-ancestors\b/i.test(d)).join(';').trim()).filter(Boolean);
        if (kept.length) headers[k] = kept;
        changed = true;
        continue;
      }
      if (key === 'set-cookie' && https) {
        // SameSite=None is only honoured with Secure, so plain-http cookies are left alone
        headers[k] = (Array.isArray(v) ? v : [v]).map((line) => line.replace(/;\s*samesite=[^;]*/gi, '').replace(/;\s*secure(?=;|$)/gi, '') + '; SameSite=None; Secure');
        changed = true;
        continue;
      }
      headers[k] = v;
    }
    callback(changed ? { responseHeaders: headers } : {});
  });
  win.loadURL(URL);
  // Every external link (Cove, X, charts, explorers) opens in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(URL)) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  win.webContents.on('unresponsive', () => console.error('[desktop] page unresponsive'));
  win.webContents.on('responsive', () => console.log('[desktop] page responsive again'));
  win.on('closed', () => (win = null));
}

// ---------- auto-update (GitHub Releases) ----------
// Windows: downloads silently, installs on quit (or now, if you say so).
// macOS: the same once the app is signed + notarized; an unsigned build can only
// point you at the release page, which is what the fallback below does.
/** The GitHub release body as plain bullet text (markdown stripped), capped for a dialog. */
function releaseNotesText(info) {
  let raw = info?.releaseNotes;
  if (Array.isArray(raw)) raw = raw.map((n) => n?.note ?? '').join('\n');
  if (typeof raw !== 'string' || !raw.trim()) return '';
  const text = raw
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/^\s*[-*]\s+/gm, '• ')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return text.length > 900 ? `${text.slice(0, 900).replace(/\s+\S*$/, '')}…` : text;
}

let updater = null;
let updateReady = null;
let checking = false;

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    updater = autoUpdater;
  } catch (e) {
    console.warn('[update] electron-updater unavailable', e?.message);
    return;
  }
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;
  updater.logger = console;
  updater.on('update-available', (info) => console.log('[update] available', info?.version));
  updater.on('update-not-available', () => {
    if (checking) dialog.showMessageBox({ message: `opentrench ${app.getVersion()} is up to date.`, buttons: ['OK'] });
    checking = false;
  });
  updater.on('update-downloaded', async (info) => {
    updateReady = info?.version ?? 'new';
    checking = false;
    const notes = releaseNotesText(info);
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      message: `opentrench ${updateReady} is ready`,
      detail: `${notes ? `What's new:\n${notes}\n\n` : ''}Restart now to install it, or it installs the next time you quit.`,
      buttons: ['Restart now', 'Later', 'Full notes'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      stopBackend();
      updater.quitAndInstall();
    } else if (response === 2) {
      shell.openExternal(`https://github.com/frogeth/opentrench/releases/tag/v${updateReady}`);
    }
  });
  updater.on('error', async (err) => {
    const msg = String(err?.message ?? err);
    console.warn('[update] error', msg);
    // Unsigned macOS builds cannot self-update: offer the download page instead.
    if (process.platform === 'darwin' && /sign|code signature|Squirrel/i.test(msg)) {
      const { response } = await dialog.showMessageBox(win ?? undefined, {
        type: 'info',
        message: 'A newer opentrench is available',
        detail: 'This copy is not signed, so it cannot update itself. Download the new version and drag it over the old one.',
        buttons: ['Open download page', 'Later'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) shell.openExternal(RELEASES_URL);
    } else if (checking) {
      // A release that is still uploading has no manifest yet: say so instead of dumping the stack.
      const publishing = /latest(-mac)?\.yml/.test(msg) && /404/.test(msg);
      dialog.showMessageBox({
        type: publishing ? 'info' : 'warning',
        message: publishing ? 'A new version is being published right now' : 'Update check failed',
        detail: publishing ? 'Try again in a few minutes.' : msg.split('\n')[0],
        buttons: ['OK'],
      });
    }
    checking = false;
  });
  const check = () => updater.checkForUpdates().catch(() => {});
  setTimeout(check, 4000);
  setInterval(check, 60 * 60 * 1000);
}

function checkForUpdatesNow() {
  if (!updater) {
    dialog.showMessageBox({ message: 'Updates only work in the packaged app.', buttons: ['OK'] });
    return;
  }
  checking = true;
  updater.checkForUpdates().catch(() => {});
}

// ---------- one-click Discord setup ----------
// The page asks over IPC (preload.js); the confirmation is a native dialog so a page can never
// trigger the install on its own. The same flow hangs off the app menu.
async function confirmDiscordSetup() {
  const p = paths();
  const st = await discordSetup.status(p.vencord, p.data);
  if (!st.available) return { ok: false, error: st.reason };
  const target = st.installs[0];
  if (!target) return { ok: false, error: process.platform === 'darwin' ? 'Discord is not installed in /Applications' : 'Discord is not installed for this user' };
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'question',
    buttons: ['Set up Discord', 'Cancel'],
    defaultId: 0,
    cancelId: 1,
    message: `Set up Discord (${target.name})`,
    detail:
      `opentrench will quit Discord, install its copy of Vencord with the opentrench plugin into\n${target.path}\nand open Discord again.\n\n` +
      (target.injected
        ? 'Vencord is already installed there. It will be replaced by this copy: the same Vencord plus the opentrench plugin, with your settings and plugins kept.'
        : "Vencord is a Discord client mod. Client mods are outside Discord's terms; Vencord has a very large user base and Discord has not banned for it."),
  });
  if (response !== 0) return { ok: false, cancelled: true };
  try {
    const r = await discordSetup.setup({ bundledDir: p.vencord, dataDir: p.data, port: PORT, flavour: target.id, log: (m) => console.log('[discord-setup]', m) });
    console.log('[discord-setup] done', JSON.stringify(r));
    return r;
  } catch (e) {
    console.error('[discord-setup]', e);
    if (e.code === 'APP_MANAGEMENT' && process.platform === 'darwin') {
      // macOS gates changes to other apps' bundles behind App Management; the pane is one click away
      const { response } = await dialog.showMessageBox(win ?? undefined, {
        type: 'warning',
        buttons: ['Open System Settings', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: 'macOS needs your permission first',
        detail: 'To install the plugin, opentrench has to change files inside the Discord app. macOS only allows that for apps listed under Privacy & Security → App Management.\n\nTurn on opentrench there, come back, and press Set up Discord again.',
      });
      if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_AppBundles');
    }
    return { ok: false, error: e.message };
  }
}
async function confirmDiscordRemove() {
  const p = paths();
  const st = await discordSetup.status(p.vencord, p.data);
  const target = st.installs.find((i) => i.injected);
  if (!target) return { ok: true, nothing: true };
  const { response } = await dialog.showMessageBox(win ?? undefined, {
    type: 'question',
    buttons: ['Remove', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: `Remove the plugin from ${target.name}?`,
    detail: `This puts Discord's original files back (Vencord is removed entirely from ${target.path}) and reopens Discord.`,
  });
  if (response !== 0) return { ok: false, cancelled: true };
  try {
    return await discordSetup.remove({ flavour: target.id });
  } catch (e) {
    console.error('[discord-setup] remove', e);
    return { ok: false, error: e.message };
  }
}
function wireDiscordSetup() {
  ipcMain.handle('discord:status', () => {
    const p = paths();
    return discordSetup.status(p.vencord, p.data);
  });
  ipcMain.handle('discord:setup', () => confirmDiscordSetup());
  ipcMain.handle('discord:remove', () => confirmDiscordRemove());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('updates:check', () => {
    checkForUpdatesNow();
    return { ok: true, version: app.getVersion() };
  });
  // a newer bundled build (after an app update) replaces the copy Discord loads; Discord picks it up on its next launch
  try {
    const p = paths();
    if (discordSetup.refreshDist(p.vencord, p.data)) console.log('[discord-setup] refreshed the Vencord build in', p.data);
  } catch (e) {
    console.error('[discord-setup] refresh', e);
  }
}

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: checkForUpdatesNow },
              { label: 'Set up Discord Plugin…', click: () => void confirmDiscordSetup() },
              { label: 'Open Log Folder', click: () => shell.openPath(app.getPath('logs')) },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : [{ label: 'File', submenu: [{ label: 'Check for Updates…', click: checkForUpdatesNow }, { label: 'Set up Discord Plugin…', click: () => void confirmDiscordSetup() }, { label: 'Open Log Folder', click: () => shell.openPath(app.getPath('logs')) }, { type: 'separator' }, { role: 'quit' }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  openLog();
  buildMenu();
  wireDiscordSetup();
  try {
    if (!(await startBackend())) {
      app.quit();
      return;
    }
  } catch (e) {
    console.error('[desktop]', e);
  }
  createWindow();
  setupUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

function stopBackend() {
  if (child) {
    child.kill('SIGTERM');
    child = null;
  }
}
app.on('before-quit', stopBackend);
process.on('exit', stopBackend);
