// One-click Discord setup. Installs the Vencord build the app ships (upstream Vencord plus the
// opentrench bridge plugin, see scripts/build-vencord.sh) into the user's Discord the way
// Vencord's own installer does: Discord's `resources/app.asar` becomes `_app.asar`, and a tiny
// new `app.asar` (index.js + package.json) is written in its place whose index.js requires our
// `patcher.js`. Vencord's patcher finds the real app in `_app.asar` next to it and boots Discord.
// The plugin is switched on in Vencord's settings file before Discord comes back up.
//
// Removing puts `_app.asar` back. If the user already had Vencord, ours replaces it (it is the
// same Vencord with one extra plugin; their settings and plugins carry over untouched).
// Electron's own `fs` treats every path ending in .asar as an archive to read *inside* of, so
// Discord's app.asar cannot be read, renamed or replaced through it ("ENOENT, not found in
// app.asar"). `original-fs` is the unpatched module; under plain Node it does not exist.
const fs = (() => {
  try {
    return require('original-fs');
  } catch {
    return require('node:fs');
  }
})();
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');

const PLUGIN = 'OpentrenchBridge';
const FLAVOURS =
  process.platform === 'darwin'
    ? [
        { id: 'stable', name: 'Discord', bundle: 'Discord.app', proc: 'Discord' },
        { id: 'ptb', name: 'Discord PTB', bundle: 'Discord PTB.app', proc: 'Discord PTB' },
        { id: 'canary', name: 'Discord Canary', bundle: 'Discord Canary.app', proc: 'Discord Canary' },
      ]
    : [
        { id: 'stable', name: 'Discord', dir: 'Discord', exe: 'Discord.exe' },
        { id: 'ptb', name: 'Discord PTB', dir: 'DiscordPTB', exe: 'DiscordPTB.exe' },
        { id: 'canary', name: 'Discord Canary', dir: 'DiscordCanary', exe: 'DiscordCanary.exe' },
      ];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { windowsHide: true }, (err, stdout) => resolve({ ok: !err, out: String(stdout ?? '') })));

/** A Discord install: where its resources live and how to stop and start it. */
function findInstalls() {
  const out = [];
  const hasApp = (resources) => fs.existsSync(path.join(resources, 'app.asar')) || fs.existsSync(path.join(resources, '_app.asar'));
  if (process.platform === 'darwin') {
    for (const f of FLAVOURS) {
      for (const dir of ['/Applications', path.join(os.homedir(), 'Applications')]) {
        const appPath = path.join(dir, f.bundle);
        const resources = path.join(appPath, 'Contents', 'Resources');
        if (hasApp(resources)) out.push({ ...f, appPath, resources });
      }
    }
  } else if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    for (const f of FLAVOURS) {
      const base = path.join(process.env.LOCALAPPDATA, f.dir);
      if (!fs.existsSync(base)) continue;
      const versions = fs
        .readdirSync(base)
        .filter((n) => /^app-\d/.test(n))
        .sort((a, b) => cmpVersion(b.slice(4), a.slice(4)));
      for (const v of versions) {
        const resources = path.join(base, v, 'resources');
        if (hasApp(resources)) {
          out.push({ ...f, appPath: base, resources, updater: path.join(base, 'Update.exe') });
          break;
        }
      }
    }
  }
  return out;
}
function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** What is in resources/: the real Discord asar, or an injector (and where it points). */
function inspect(resources) {
  const appAsar = path.join(resources, 'app.asar');
  const st = fs.existsSync(appAsar) ? fs.statSync(appAsar) : null;
  let injector = null;
  if (st && st.size < 64 * 1024) {
    const m = /require\("((?:[^"\\]|\\.)*)"\)/.exec(fs.readFileSync(appAsar, 'latin1'));
    if (m) {
      try {
        injector = JSON.parse(`"${m[1]}"`);
      } catch {
        injector = m[1];
      }
    }
  }
  return { hasApp: !!st, hasOriginal: fs.existsSync(path.join(resources, '_app.asar')), injector };
}

/**
 * A minimal asar writer: an 8-byte size pickle, a header pickle (JSON directory, padded to 4),
 * then the file bodies. Byte-for-byte what Vencord's installer produces for the same files.
 */
function makeAsar(files) {
  const entries = {};
  const bodies = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const buf = Buffer.from(data);
    entries[name] = { size: buf.length, offset: String(offset) };
    bodies.push(buf);
    offset += buf.length;
  }
  const header = Buffer.from(JSON.stringify({ files: entries }), 'utf8');
  const padded = Math.ceil(header.length / 4) * 4;
  const headerPickle = Buffer.alloc(8 + padded);
  headerPickle.writeUInt32LE(padded + 4, 0);
  headerPickle.writeUInt32LE(header.length, 4);
  header.copy(headerPickle, 8);
  const sizePickle = Buffer.alloc(8);
  sizePickle.writeUInt32LE(4, 0);
  sizePickle.writeUInt32LE(headerPickle.length, 4);
  return Buffer.concat([sizePickle, headerPickle, ...bodies]);
}

function injectorAsar(patcherPath) {
  return makeAsar({
    'index.js': `require(${JSON.stringify(patcherPath)})`,
    'package.json': '{\n\t"name": "discord",\n\t"main": "index.js"\n}',
  });
}

async function isRunning(install) {
  if (process.platform === 'darwin') return (await run('pgrep', ['-x', install.proc])).ok;
  const r = await run('tasklist', ['/FI', `IMAGENAME eq ${install.exe}`, '/NH']);
  return r.ok && r.out.toLowerCase().includes(install.exe.toLowerCase());
}
async function quit(install) {
  if (!(await isRunning(install))) return;
  if (process.platform === 'darwin') await run('osascript', ['-e', `tell application "${install.proc}" to quit`]);
  else await run('taskkill', ['/F', '/IM', install.exe]);
  for (let i = 0; i < 40; i++) {
    if (!(await isRunning(install))) return;
    await sleep(250);
  }
  if (process.platform === 'darwin') await run('pkill', ['-x', install.proc]);
  for (let i = 0; i < 20; i++) {
    if (!(await isRunning(install))) return;
    await sleep(250);
  }
  throw new Error(`${install.name} did not quit`);
}
async function launch(install) {
  if (process.platform === 'darwin') await run('open', ['-a', install.appPath]);
  else await run(install.updater, ['--processStart', install.exe]);
}

/** Vencord's settings file: `plugins.OpentrenchBridge.enabled = true`, pointed at our port. */
function vencordSettingsFile() {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Vencord')
      : process.platform === 'win32'
        ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Vencord')
        : path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Vencord');
  return path.join(base, 'settings', 'settings.json');
}
function enablePlugin(port) {
  const file = vencordSettingsFile();
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* fresh */
  }
  s.plugins = s.plugins ?? {};
  s.plugins[PLUGIN] = { ...(s.plugins[PLUGIN] ?? {}), enabled: true, port };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(s, null, 4));
}

/** The bundled build, and our copy of it in the app's data folder (Discord loads it from there). */
function distPaths(bundledDir, dataDir) {
  const bundled = path.join(bundledDir, 'dist');
  const version = (() => {
    try {
      return fs.readFileSync(path.join(bundledDir, 'VERSION'), 'utf8').trim();
    } catch {
      return '';
    }
  })();
  const ours = path.join(dataDir, 'vencord');
  return { available: fs.existsSync(path.join(bundled, 'patcher.js')), bundled, version, ours, dist: path.join(ours, 'dist'), patcher: path.join(ours, 'dist', 'patcher.js') };
}
/** Copy the bundled build into place when it is missing or older. Returns true when it changed. */
function refreshDist(bundledDir, dataDir) {
  const p = distPaths(bundledDir, dataDir);
  if (!p.available) return false;
  const stamp = path.join(p.ours, 'VERSION');
  let have = '';
  try {
    have = fs.readFileSync(stamp, 'utf8').trim();
  } catch {
    /* none yet */
  }
  if (have && have === p.version && fs.existsSync(p.patcher)) return false;
  fs.rmSync(p.dist, { recursive: true, force: true });
  fs.mkdirSync(p.ours, { recursive: true });
  fs.cpSync(p.bundled, p.dist, { recursive: true });
  for (const f of ['LICENSE']) if (fs.existsSync(path.join(bundledDir, f))) fs.copyFileSync(path.join(bundledDir, f), path.join(p.ours, f));
  fs.writeFileSync(stamp, p.version);
  return true;
}

async function status(bundledDir, dataDir) {
  const p = distPaths(bundledDir, dataDir);
  const installs = [];
  for (const i of findInstalls()) {
    const s = inspect(i.resources);
    installs.push({ id: i.id, name: i.name, path: i.resources, injected: !!s.injector, ours: !!s.injector && s.injector.startsWith(p.ours), running: await isRunning(i) });
  }
  return { available: p.available, version: p.version, installs, reason: p.available ? undefined : 'this build of opentrench does not include the Discord plugin' };
}

/** Quit Discord, put our Vencord in, switch the plugin on, bring Discord back. */
async function setup({ bundledDir, dataDir, port = 3210, flavour, log = () => {} }) {
  const p = distPaths(bundledDir, dataDir);
  if (!p.available) throw new Error('this build of opentrench does not include the Discord plugin');
  const installs = findInstalls();
  const install = flavour ? installs.find((i) => i.id === flavour) : installs[0];
  if (!install) throw new Error(process.platform === 'darwin' ? 'Discord is not installed in /Applications' : 'Discord is not installed for this user');
  refreshDist(bundledDir, dataDir);
  log(`quitting ${install.name}`);
  await quit(install);
  const before = inspect(install.resources);
  const appAsar = path.join(install.resources, 'app.asar');
  const original = path.join(install.resources, '_app.asar');
  try {
    if (!before.injector) {
      // a real Discord asar in place; a leftover _app.asar is from a Discord update that wrote over an injection
      if (before.hasOriginal) fs.rmSync(original, { force: true });
      fs.renameSync(appAsar, original);
    } else if (!before.hasOriginal) {
      throw new Error(`${install.name} has an injector but no _app.asar next to it; reinstall Discord`);
    }
    fs.writeFileSync(appAsar, injectorAsar(p.patcher));
    enablePlugin(port);
  } catch (e) {
    // nothing was changed (the first write is what fails): bring Discord back, then explain
    await launch(install).catch(() => {});
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) {
      const err = new Error(
        process.platform === 'darwin'
          ? `macOS blocked the change to ${install.name} (App Management). Allow opentrench under System Settings → Privacy & Security → App Management, then press Set up Discord again.`
          : `no permission to change ${install.resources}; run opentrench as the user who installed Discord`,
      );
      err.code = 'APP_MANAGEMENT';
      throw err;
    }
    throw e;
  }
  log(`injected into ${install.resources}`);
  await launch(install);
  return { ok: true, install: install.name, replaced: !!before.injector && !(before.injector ?? '').startsWith(p.ours) };
}

/** Put the original app.asar back (removes Vencord entirely) and restart Discord. */
async function remove({ flavour } = {}) {
  const installs = findInstalls();
  const install = flavour ? installs.find((i) => i.id === flavour) : installs.find((i) => inspect(i.resources).injector) ?? installs[0];
  if (!install) throw new Error('Discord is not installed');
  const s = inspect(install.resources);
  if (!s.injector || !s.hasOriginal) return { ok: true, install: install.name, nothing: true };
  await quit(install);
  fs.rmSync(path.join(install.resources, 'app.asar'), { force: true });
  fs.renameSync(path.join(install.resources, '_app.asar'), path.join(install.resources, 'app.asar'));
  await launch(install);
  return { ok: true, install: install.name };
}

module.exports = { findInstalls, inspect, makeAsar, injectorAsar, refreshDist, distPaths, status, setup, remove, vencordSettingsFile, enablePlugin };
