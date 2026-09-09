// opentrench desktop: runs the backend with Electron's bundled Node and opens a window on it.
const { app, BrowserWindow, shell, nativeTheme } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = Number(process.env.TRENCHFEED_PORT ?? 3210);
const URL = `http://127.0.0.1:${PORT}`;
let child = null;
let win = null;

function paths() {
  const packaged = app.isPackaged;
  const backendDir = packaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..', 'backend');
  const entry = path.join(backendDir, 'dist', 'index.js');
  const data = app.getPath('userData');
  return { packaged, backendDir, entry, data, config: path.join(data, 'config.json'), state: path.join(data, 'state.json') };
}

/** First run from the repo: adopt the dev checkout's config/state so no re-login is needed. */
function adoptDevFiles(p) {
  fs.mkdirSync(p.data, { recursive: true });
  // Renamed from trenchfeed: adopt the old app-data folder once.
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

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (e) {
    console.error('[desktop]', e);
  }
  createWindow();
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
