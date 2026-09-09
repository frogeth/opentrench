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

async function startBackend() {
  const p = paths();
  if (await ping()) {
    console.log('[desktop] backend already running on', URL, '— attaching');
    return;
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
    const { response } = await dialog.showMessageBox(win ?? undefined, {
      type: 'info',
      message: `opentrench ${updateReady} is ready`,
      detail: 'Restart now to install it, or it installs the next time you quit.',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      stopBackend();
      updater.quitAndInstall();
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
      dialog.showMessageBox({ type: 'warning', message: 'Update check failed', detail: msg, buttons: ['OK'] });
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
    await startBackend();
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
