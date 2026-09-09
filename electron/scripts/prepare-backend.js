// Stage a production copy of the backend (dist + runtime deps only) for electron-builder.
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..', '..');
const src = path.join(root, 'backend');
const out = path.resolve(__dirname, '..', 'resources', 'backend');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.cpSync(path.join(src, 'dist'), path.join(out, 'dist'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(src, 'package.json'), 'utf8'));
delete pkg.devDependencies;
delete pkg.scripts;
fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2));
console.log('[prepare-backend] installing runtime deps…');
execSync('npm install --omit=dev --no-audit --no-fund --ignore-scripts', { cwd: out, stdio: 'inherit' });
console.log('[prepare-backend] ready at', out);
