// The file moves behind one-click Discord setup, on throwaway folders shaped like Discord's
// resources/ and BetterDiscord's data folder. Nothing here touches a real Discord.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import setup from './discord-setup.js';

const { inspect, modOf, injectorAsar, injectBetterDiscord, uninjectBetterDiscord, uninjectVencord, prepareBetterDiscord, refreshBdPlugin, bdPaths } = setup;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ot-discord-'));
const REAL = 'the real discord app.asar';
/** a resources/ folder with Discord's own app.asar */
function resources() {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'app.asar'), REAL);
  return dir;
}
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));
/** a bundled betterdiscord folder, as scripts/build-betterdiscord.sh lays it out */
function bundled(plugin = '/** @name OpentrenchBridge */ module.exports = class {};') {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'betterdiscord.asar'), 'bundled bd');
  fs.writeFileSync(path.join(dir, 'OpentrenchBridge.plugin.js'), plugin);
  return dir;
}

test('a clean Discord is not injected', () => {
  const r = resources();
  assert.equal(modOf(inspect(r)), null);
});

test('BetterDiscord: inject keeps the real app as betterdiscord.app.asar and writes app/', () => {
  const r = resources();
  injectBetterDiscord(r);
  assert.equal(exists(r, 'app.asar'), false);
  assert.equal(read(r, 'betterdiscord.app.asar'), REAL);
  assert.match(read(r, 'app', 'index.js'), /require\(path\.join\(userConfig, "BetterDiscord", "data", "betterdiscord\.asar"\)\)/);
  assert.match(read(r, 'app', 'index.js'), /module\.exports = require\("\.\.\/betterdiscord\.app\.asar"\)/);
  assert.equal(JSON.parse(read(r, 'app', 'package.json')).main, './index.js');
  assert.equal(modOf(inspect(r)), 'betterdiscord');
});

test('BetterDiscord: injecting twice is harmless', () => {
  const r = resources();
  injectBetterDiscord(r);
  injectBetterDiscord(r);
  assert.equal(read(r, 'betterdiscord.app.asar'), REAL);
  assert.equal(modOf(inspect(r)), 'betterdiscord');
});

test('BetterDiscord: after a Discord update wrote a new app.asar, the stale preserved copy is replaced', () => {
  const r = resources();
  injectBetterDiscord(r);
  fs.writeFileSync(path.join(r, 'app.asar'), 'updated discord');
  assert.equal(modOf(inspect(r)), null, 'a live app.asar wins over app/, so BetterDiscord is not loading');
  injectBetterDiscord(r);
  assert.equal(read(r, 'betterdiscord.app.asar'), 'updated discord');
  assert.equal(modOf(inspect(r)), 'betterdiscord');
});

test('BetterDiscord: uninject restores the original app.asar and removes app/', () => {
  const r = resources();
  injectBetterDiscord(r);
  uninjectBetterDiscord(r);
  assert.equal(read(r, 'app.asar'), REAL);
  assert.equal(exists(r, 'app'), false);
  assert.equal(exists(r, 'betterdiscord.app.asar'), false);
  assert.equal(modOf(inspect(r)), null);
});

test('BetterDiscord: with nothing to restore, uninject refuses and leaves app/ in place', () => {
  const r = resources();
  injectBetterDiscord(r);
  fs.rmSync(path.join(r, 'betterdiscord.app.asar'));
  assert.throws(() => uninjectBetterDiscord(r), /reinstall Discord/);
  assert.equal(exists(r, 'app', 'index.js'), true);
});

test('Vencord: inspect sees an injector, uninject puts _app.asar back', () => {
  const r = resources();
  fs.renameSync(path.join(r, 'app.asar'), path.join(r, '_app.asar'));
  fs.writeFileSync(path.join(r, 'app.asar'), injectorAsar('/somewhere/vencord/dist/patcher.js'));
  const s = inspect(r);
  assert.equal(modOf(s), 'vencord');
  assert.equal(s.injector, '/somewhere/vencord/dist/patcher.js');
  uninjectVencord(r);
  assert.equal(read(r, 'app.asar'), REAL);
  assert.equal(exists(r, '_app.asar'), false);
});

test('switching Vencord → BetterDiscord ends with only BetterDiscord, on the real app', () => {
  const r = resources();
  fs.renameSync(path.join(r, 'app.asar'), path.join(r, '_app.asar'));
  fs.writeFileSync(path.join(r, 'app.asar'), injectorAsar('/x/patcher.js'));
  uninjectVencord(r);
  injectBetterDiscord(r);
  assert.equal(modOf(inspect(r)), 'betterdiscord');
  assert.equal(read(r, 'betterdiscord.app.asar'), REAL);
  assert.equal(exists(r, '_app.asar'), false);
});

test('prepareBetterDiscord: installs BetterDiscord and the plugin, switches it on for the channel, sets the port', () => {
  const root = tmp();
  const b = bundled();
  fs.mkdirSync(path.join(root, 'data', 'stable'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'stable', 'plugins.json'), JSON.stringify({ SomeoneElses: true }));
  prepareBetterDiscord(b, 'stable', 4321, root);
  assert.equal(read(root, 'data', 'betterdiscord.asar'), 'bundled bd');
  assert.match(read(root, 'plugins', 'OpentrenchBridge.plugin.js'), /@name OpentrenchBridge/);
  assert.deepEqual(JSON.parse(read(root, 'data', 'stable', 'plugins.json')), { SomeoneElses: true, OpentrenchBridge: true });
  assert.equal(JSON.parse(read(root, 'plugins', 'OpentrenchBridge.config.json')).port, 4321);
  assert.equal(exists(root, 'themes'), true);
});

test('prepareBetterDiscord: an installed BetterDiscord (likely self-updated and newer) is kept', () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'data', 'betterdiscord.asar'), 'users newer bd');
  prepareBetterDiscord(bundled(), 'canary', 3210, root);
  assert.equal(read(root, 'data', 'betterdiscord.asar'), 'users newer bd');
  assert.equal(JSON.parse(read(root, 'data', 'canary', 'plugins.json')).OpentrenchBridge, true);
});

test('refreshBdPlugin: replaces an installed, different plugin; leaves a missing one missing', () => {
  const root = tmp();
  assert.equal(refreshBdPlugin(bundled('v2'), root), false);
  assert.equal(exists(root, 'plugins', 'OpentrenchBridge.plugin.js'), false);
  prepareBetterDiscord(bundled('v1'), 'stable', 3210, root);
  assert.equal(refreshBdPlugin(bundled('v1'), root), false);
  assert.equal(refreshBdPlugin(bundled('v2'), root), true);
  assert.equal(read(root, 'plugins', 'OpentrenchBridge.plugin.js'), 'v2');
});

test('bdPaths: unavailable without a bundled folder or with half of it', () => {
  assert.equal(bdPaths(undefined).available, false);
  const b = bundled();
  assert.equal(bdPaths(b).available, true);
  fs.rmSync(path.join(b, 'betterdiscord.asar'));
  assert.equal(bdPaths(b).available, false);
});
