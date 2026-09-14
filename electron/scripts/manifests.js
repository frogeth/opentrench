#!/usr/bin/env node
// Write the auto-update manifests (latest.yml for Windows, latest-mac.yml for macOS) for one
// version from the installers in dist/, in the exact shape electron-builder's GitHub publisher
// produces. The release script builds with --publish never and uploads through the GitHub CLI
// (electron-builder's own uploader stalls without an error from this network), so the manifests
// have to be produced here.
//   node scripts/manifests.js <version> [distDir]
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const version = process.argv[2];
const dist = process.argv[3] || path.join(__dirname, '..', 'dist');
if (!version) {
  console.error('usage: manifests.js <version> [distDir]');
  process.exit(2);
}
const sha512 = (file) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest('base64');
const entry = (name) => {
  const file = path.join(dist, name);
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`);
  return { name, sha512: sha512(file), size: fs.statSync(file).size };
};
const yaml = (files, main) =>
  [`version: ${version}`, 'files:', ...files.flatMap((f) => [`  - url: ${f.name}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]), `path: ${main.name}`, `sha512: ${main.sha512}`, `releaseDate: '${new Date().toISOString()}'`, ''].join('\n');

// macOS: zips first (what the updater downloads), then the dmgs; the x64 zip is `path` like electron-builder writes it
const mac = ['opentrench-VERSION-mac.zip', 'opentrench-VERSION-arm64-mac.zip', 'opentrench-VERSION.dmg', 'opentrench-VERSION-arm64.dmg'].map((n) => entry(n.replace('VERSION', version)));
fs.writeFileSync(path.join(dist, 'latest-mac.yml'), yaml(mac, mac[0]));
// Windows: electron-builder names the file with spaces on disk and dashes on GitHub
const exeOnDisk = path.join(dist, `opentrench Setup ${version}.exe`);
const exeName = `opentrench-Setup-${version}.exe`;
if (fs.existsSync(exeOnDisk)) fs.copyFileSync(exeOnDisk, path.join(dist, exeName)); // always refresh: a stale dashed copy from an earlier build must not win
const bmOnDisk = path.join(dist, `opentrench Setup ${version}.exe.blockmap`);
if (fs.existsSync(bmOnDisk)) fs.copyFileSync(bmOnDisk, path.join(dist, `${exeName}.blockmap`));
const win = [entry(exeName)];
fs.writeFileSync(path.join(dist, 'latest.yml'), yaml(win, win[0]));
console.log(`manifests for ${version}: ${mac.map((f) => f.name).join(', ')}; ${exeName}`);
