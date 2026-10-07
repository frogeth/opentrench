// Bundle the BetterDiscord plugin (index.ts + the shared core) into one OpentrenchBridge.plugin.js,
// the single-file format BetterDiscord loads from its plugins folder.
//   node betterdiscord/build.mjs [out-dir]      (default: betterdiscord/dist)
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(process.argv[2] ?? path.join(here, 'dist'));
const version = JSON.parse(readFileSync(path.join(here, '..', 'electron', 'package.json'), 'utf8')).version;

// BetterDiscord reads the plugin's name, version and description from this header
const banner = `/**
 * @name OpentrenchBridge
 * @author opentrench
 * @description Feeds opentrench from this Discord client (no token, no self-bot) and lets it send through it.
 * @version ${version}
 * @website https://github.com/frogeth/opentrench
 * @source https://github.com/frogeth/opentrench/tree/main/betterdiscord
 */`;

await build({
  entryPoints: [path.join(here, 'index.ts')],
  outfile: path.join(outDir, 'OpentrenchBridge.plugin.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  banner: { js: banner },
  // BetterDiscord takes the class from module.exports, not module.exports.default
  footer: { js: 'module.exports = module.exports.default;' },
  logLevel: 'warning',
});
console.log(`==> ${path.join(outDir, 'OpentrenchBridge.plugin.js')} (v${version})`);
