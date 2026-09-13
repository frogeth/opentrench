// opentrench desktop: runs the backend with Electron's bundled Node and opens a window on it.
const { app, BrowserWindow, shell, nativeTheme, dialog, Menu } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.TRENCHFEED_PORT ?? 3210);
const URL = `http://127.0.0.1:${PORT}`;
const RELEASES_URL = 'https://github.com/frogeth/opentrench/releases/latest';
let child = null;
let win = null;

function paths() {
  const packaged = app.isPackaged;
  const backendDir = packaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..', 'backend');
  const entry = path.join(backendDir, 'dist', 'index.js');
  const data = app.getPath('userData');
  return { packaged, backendDir, entry, data, config: path.join(data, 'config.json'), state: path.join(data, 'state.json') };
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

/** What the backend on the port says it is; null when it predates /api/version or is unreachable. */
function backendVersion() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/version`, { timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve(res.statusCode === 200 ? String(JSON.parse(body).version ?? '') : null);
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

/** @returns false when the app should quit instead of opening a window */
async function startBackend() {
  const p = paths();
  if (await ping()) {
    // Attaching to a backend from another build is how a column type the backend has never heard
    // of silently turns into a chat column: its config parser rewrites what it doesn't know. A
    // stale `npm start` from an older checkout is the usual culprit.
    const v = await backendVersion();
    if (v !== app.getVersion()) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: `Another opentrench backend is already running on port ${PORT}`,
        detail: `It reports version ${v || 'unknown (an older build)'}; this app is ${app.getVersion()}. A backend from a different build rewrites newer column types and hides newer features. Quit that process (a stale "npm start"?) and open opentrench again, or attach anyway.`,
        buttons: ['Quit', 'Attach anyway'],
        defaultId: 0,
        cancelId: 0,
      });
      if (response === 0) return false;
    }
    console.log('[desktop] backend already running on', URL, '— attaching');
    return true;
  }
  adoptDevFiles(p);
  if (!fs.existsSync(p.entry)) throw new Error(`backend not built: ${p.entry}`);
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`[backend] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[backend] ${d}`));
  child.on('exit', (code) => {
    console.log('[desktop] backend exited', code);
    child = null;
  });
  if (!(await waitFor(20_000))) throw new Error('backend did not come up');
  return true;
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
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: { contextIsolation: true, sandbox: true },
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

function buildMenu() {
  const template = [
    ...(process.platform === 'darwin'
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              { label: 'Check for Updates…', click: checkForUpdatesNow },
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
      : [{ label: 'File', submenu: [{ label: 'Check for Updates…', click: checkForUpdatesNow }, { type: 'separator' }, { role: 'quit' }] }]),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  buildMenu();
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
