// One-click Discord setup, with either client mod the user picks.
//
// Vencord: installs the Vencord build the app ships (upstream Vencord plus the opentrench bridge
// plugin, see scripts/build-vencord.sh) the way Vencord's own installer does: Discord's
// `resources/app.asar` becomes `_app.asar`, and a tiny new `app.asar` (index.js + package.json) is
// written in its place whose index.js requires our `patcher.js`. Vencord's patcher finds the real
// app in `_app.asar` next to it and boots Discord. The plugin is switched on in Vencord's settings
// file before Discord comes back up. If the user already had Vencord, ours replaces it (it is the
// same Vencord with one extra plugin; their settings and plugins carry over untouched).
//
// BetterDiscord: the way BetterDiscord's own installer does it (github.com/BetterDiscord/Installer,
// discord/injection.go): `app.asar` becomes `betterdiscord.app.asar` and an `app/` folder is
// written whose index.js loads `BetterDiscord/data/betterdiscord.asar` and then the real app.
// The pinned betterdiscord.asar the app ships (scripts/build-betterdiscord.sh) is only put there
// when none is installed yet: BetterDiscord updates itself. Our plugin is one file in
// `BetterDiscord/plugins/`, switched on in that Discord channel's `plugins.json`.
//
// Only one of the two is injected at a time; picking the other undoes the first. Removing puts
// Discord's original app.asar back.
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
/** where BetterDiscord's injection keeps Discord's real app.asar */
const BD_PRESERVED = 'betterdiscord.app.asar';
const MODS = { vencord: 'Vencord', betterdiscord: 'BetterDiscord' };
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
  const hasApp = (resources) => ['app.asar', '_app.asar', BD_PRESERVED].some((f) => fs.existsSync(path.join(resources, f)));
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

/**
 * What is in resources/: the real Discord asar, a Vencord-style injector (and where it points),
 * or BetterDiscord's app/ folder. A live app.asar wins over app/ when Electron boots, so app/
 * only counts while app.asar is gone.
 */
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
  const betterdiscord = !st && fs.existsSync(path.join(resources, 'app', 'index.js')) && fs.existsSync(path.join(resources, BD_PRESERVED));
  return { hasApp: !!st, hasOriginal: fs.existsSync(path.join(resources, '_app.asar')), injector, betterdiscord };
}
/** which client mod is injected: 'vencord' (any Vencord-style injector), 'betterdiscord' or null */
const modOf = (s) => (s.injector ? 'vencord' : s.betterdiscord ? 'betterdiscord' : null);

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

// ---------- BetterDiscord ----------

/** BetterDiscord's own folder (what its installer and its app/index.js resolve at runtime). */
function bdRoot() {
  const base =
    process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support')
      : process.platform === 'win32'
        ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
        : (process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'));
  return path.join(base, 'BetterDiscord');
}
const bdPluginFile = (root = bdRoot()) => path.join(root, 'plugins', `${PLUGIN}.plugin.js`);

/** The bundled BetterDiscord build and plugin (scripts/build-betterdiscord.sh). */
function bdPaths(bdBundledDir) {
  const asar = bdBundledDir ? path.join(bdBundledDir, 'betterdiscord.asar') : '';
  const plugin = bdBundledDir ? path.join(bdBundledDir, `${PLUGIN}.plugin.js`) : '';
  return { available: !!bdBundledDir && fs.existsSync(asar) && fs.existsSync(plugin), asar, plugin };
}

// BetterDiscord's injection script, as its installer writes it (discord/assets/app_index.js in
// github.com/BetterDiscord/Installer, MIT). A broken or missing BetterDiscord never keeps Discord
// from starting: the require is wrapped, and the real app loads either way.
const BD_APP_INDEX = `// BetterDiscord's Injection Script (app.asar method)
const path = require("path");
const electron = require("electron");

try {
    let userConfig = path.join(electron.app.getPath("userData"), "..");
    if (process.platform !== "win32" && process.platform !== "darwin") {
        const homeDir = process.env.HOME || require("os").homedir();
        userConfig = process.env.XDG_CONFIG_HOME || path.join(homeDir, ".config");
    }
    require(path.join(userConfig, "BetterDiscord", "data", "betterdiscord.asar"));
}
catch (error) {
    console.error("Failed to load BetterDiscord:", error);
}

module.exports = require("../betterdiscord.app.asar");
`;
const BD_APP_PACKAGE = '{"main": "./index.js"}';

/**
 * Put BetterDiscord, our plugin (switched on for this Discord channel) and its port in place.
 * Touches only BetterDiscord's folder, never Discord. An installed betterdiscord.asar is kept:
 * BetterDiscord updates itself, so it is likely newer than the one we ship.
 */
function prepareBetterDiscord(bdBundledDir, channel, port, root = bdRoot()) {
  const b = bdPaths(bdBundledDir);
  for (const d of ['data', 'plugins', 'themes', path.join('data', channel)]) fs.mkdirSync(path.join(root, d), { recursive: true });
  const asar = path.join(root, 'data', 'betterdiscord.asar');
  if (!fs.existsSync(asar)) fs.copyFileSync(b.asar, asar);
  fs.copyFileSync(b.plugin, bdPluginFile(root));
  const enabled = path.join(root, 'data', channel, 'plugins.json');
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(enabled, 'utf8'));
  } catch {
    /* fresh */
  }
  state[PLUGIN] = true;
  fs.writeFileSync(enabled, JSON.stringify(state, null, 4));
  // the plugin's own settings, read with BdApi.Data.load('OpentrenchBridge', 'port')
  const cfgFile = path.join(root, 'plugins', `${PLUGIN}.config.json`);
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  } catch {
    /* fresh */
  }
  cfg.port = port;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 4));
}

/** BetterDiscord's injection, rolled back on any failure so Discord always has an app to load. */
function injectBetterDiscord(resources) {
  const appAsar = path.join(resources, 'app.asar');
  const preserved = path.join(resources, BD_PRESERVED);
  const appDir = path.join(resources, 'app');
  if (fs.existsSync(appAsar)) {
    // a live app.asar is Discord's current app; a preserved copy next to it is from before a Discord update
    if (fs.existsSync(preserved)) fs.rmSync(preserved, { force: true });
    fs.renameSync(appAsar, preserved);
  } else if (!fs.existsSync(preserved)) {
    throw new Error(`no app.asar in ${resources}; reinstall Discord`);
  }
  try {
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(path.join(appDir, 'package.json'), BD_APP_PACKAGE);
    fs.writeFileSync(path.join(appDir, 'index.js'), BD_APP_INDEX);
  } catch (e) {
    fs.rmSync(appDir, { recursive: true, force: true });
    if (!fs.existsSync(appAsar) && fs.existsSync(preserved)) fs.renameSync(preserved, appAsar);
    throw e;
  }
}

/** Undo BetterDiscord's injection: the original app.asar back first, then app/ away. */
function uninjectBetterDiscord(resources) {
  const appAsar = path.join(resources, 'app.asar');
  const preserved = path.join(resources, BD_PRESERVED);
  if (fs.existsSync(preserved)) {
    if (!fs.existsSync(appAsar)) fs.renameSync(preserved, appAsar);
    else fs.rmSync(preserved, { force: true });
  }
  if (!fs.existsSync(appAsar)) throw new Error(`no app.asar to restore in ${resources}; reinstall Discord`);
  fs.rmSync(path.join(resources, 'app'), { recursive: true, force: true });
}

/**
 * Undo a Vencord-style injection: `_app.asar` back to `app.asar`, in one rename over the injector
 * (never delete-then-rename: a rename refused after the delete leaves Discord with no app.asar).
 */
function uninjectVencord(resources) {
  const appAsar = path.join(resources, 'app.asar');
  const original = path.join(resources, '_app.asar');
  if (!fs.existsSync(original)) throw new Error(`Vencord is installed in ${resources} but Discord's original _app.asar is missing; reinstall Discord`);
  fs.renameSync(original, appAsar);
}

/**
 * Can files be created in resources/? macOS App Management lets an app without the permission
 * delete inside another app's bundle but not create or rename there, so this runs before any
 * change: a refusal then leaves Discord exactly as it was.
 */
function probeWritable(resources) {
  const probe = path.join(resources, `.opentrench-probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, '');
  fs.rmSync(probe, { force: true });
}

/**
 * Discord's real app when no injector is live: `app.asar`, or a `_app.asar` left alone by an
 * injection whose app.asar is gone. Makes sure it is at `_app.asar` for a Vencord injector.
 */
function originalToUnderscore(resources) {
  const appAsar = path.join(resources, 'app.asar');
  const original = path.join(resources, '_app.asar');
  if (fs.existsSync(appAsar)) fs.renameSync(appAsar, original); // replaces a stale _app.asar from before a Discord update
  else if (!fs.existsSync(original)) throw new Error(`no app.asar in ${resources}; reinstall Discord`);
}

/** After an app update: a newer bundled plugin replaces the installed one (BetterDiscord reloads it live). */
function refreshBdPlugin(bdBundledDir, root = bdRoot()) {
  const b = bdPaths(bdBundledDir);
  const installed = bdPluginFile(root);
  if (!b.available || !fs.existsSync(installed)) return false;
  const want = fs.readFileSync(b.plugin);
  if (want.equals(fs.readFileSync(installed))) return false;
  fs.writeFileSync(installed, want);
  return true;
}

// ---------- both ----------

async function status(bundledDir, dataDir, bdBundledDir) {
  const p = distPaths(bundledDir, dataDir);
  const bd = bdPaths(bdBundledDir);
  const installs = [];
  for (const i of findInstalls()) {
    const s = inspect(i.resources);
    const mod = modOf(s);
    const ours = mod === 'vencord' ? s.injector.startsWith(p.ours) : mod === 'betterdiscord' ? fs.existsSync(bdPluginFile()) : false;
    installs.push({ id: i.id, name: i.name, path: i.resources, injected: !!mod, mod, ours, running: await isRunning(i) });
  }
  const available = p.available || bd.available;
  return {
    available,
    version: p.version,
    mods: { vencord: p.available, betterdiscord: bd.available },
    installs,
    reason: available ? undefined : 'this build of opentrench does not include the Discord plugin',
  };
}

const appManagementError = (install) => {
  const err = new Error(
    process.platform === 'darwin'
      ? `macOS blocked the change to ${install.name} (App Management). Allow opentrench under System Settings → Privacy & Security → App Management, then press Set up Discord again.`
      : `no permission to change ${install.resources}; run opentrench as the user who installed Discord`,
  );
  err.code = 'APP_MANAGEMENT';
  return err;
};

/** Quit Discord, put the chosen client mod and our plugin in, bring Discord back. */
async function setup({ bundledDir, bdBundledDir, dataDir, port = 3210, flavour, mod = 'vencord', log = () => {} }) {
  if (!MODS[mod]) throw new Error(`unknown client mod ${mod}`);
  const p = distPaths(bundledDir, dataDir);
  const bd = bdPaths(bdBundledDir);
  if (mod === 'vencord' ? !p.available : !bd.available) throw new Error(`this build of opentrench does not include the ${MODS[mod]} plugin`);
  const installs = findInstalls();
  const install = flavour ? installs.find((i) => i.id === flavour) : installs[0];
  if (!install) throw new Error(process.platform === 'darwin' ? 'Discord is not installed in /Applications' : 'Discord is not installed for this user');
  if (mod === 'vencord') refreshDist(bundledDir, dataDir);
  else prepareBetterDiscord(bdBundledDir, install.id, port);
  try {
    probeWritable(install.resources);
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw appManagementError(install);
    throw e;
  }
  log(`quitting ${install.name}`);
  await quit(install);
  const before = inspect(install.resources);
  const had = modOf(before);
  const appAsar = path.join(install.resources, 'app.asar');
  try {
    if (mod === 'vencord') {
      if (had === 'betterdiscord') uninjectBetterDiscord(install.resources);
      if (had !== 'vencord') {
        originalToUnderscore(install.resources);
      } else if (!before.hasOriginal) {
        throw new Error(`${install.name} has an injector but no _app.asar next to it; reinstall Discord`);
      }
      fs.writeFileSync(appAsar, injectorAsar(p.patcher));
      enablePlugin(port);
    } else {
      if (had === 'vencord') uninjectVencord(install.resources);
      injectBetterDiscord(install.resources);
    }
  } catch (e) {
    // the injections roll back their own partial work: bring Discord back, then explain
    await launch(install).catch(() => {});
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw appManagementError(install);
    throw e;
  }
  log(`injected ${MODS[mod]} into ${install.resources}`);
  await launch(install);
  const replaced = had === 'vencord' ? mod !== 'vencord' || !before.injector.startsWith(p.ours) : had === 'betterdiscord' && mod !== 'betterdiscord';
  return { ok: true, install: install.name, mod, replaced, replacedMod: replaced ? had : undefined };
}

/** Put the original app.asar back (removes whichever client mod is injected) and restart Discord. */
async function remove({ flavour } = {}) {
  const installs = findInstalls();
  const install = flavour ? installs.find((i) => i.id === flavour) : installs.find((i) => modOf(inspect(i.resources))) ?? installs[0];
  if (!install) throw new Error('Discord is not installed');
  const s = inspect(install.resources);
  const mod = modOf(s);
  if (!mod || (mod === 'vencord' && !s.hasOriginal)) return { ok: true, install: install.name, nothing: true };
  try {
    probeWritable(install.resources);
  } catch (e) {
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw appManagementError(install);
    throw e;
  }
  await quit(install);
  try {
    if (mod === 'vencord') uninjectVencord(install.resources);
    else {
      uninjectBetterDiscord(install.resources);
      // BetterDiscord's folder (the user's other plugins and themes) stays; only ours goes
      fs.rmSync(bdPluginFile(), { force: true });
    }
  } catch (e) {
    await launch(install).catch(() => {});
    if (e && (e.code === 'EPERM' || e.code === 'EACCES')) throw appManagementError(install);
    throw e;
  }
  await launch(install);
  return { ok: true, install: install.name, mod };
}

module.exports = {
  findInstalls,
  inspect,
  modOf,
  makeAsar,
  injectorAsar,
  refreshDist,
  distPaths,
  status,
  setup,
  remove,
  vencordSettingsFile,
  enablePlugin,
  bdRoot,
  bdPaths,
  prepareBetterDiscord,
  injectBetterDiscord,
  originalToUnderscore,
  probeWritable,
  uninjectBetterDiscord,
  uninjectVencord,
  refreshBdPlugin,
};
