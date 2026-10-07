// Copie les fichiers navigateur de xterm.js vers dist/presentation/vendor/ (servi par
// /applications/screen2http/presentation/vendor/*). Pas de CDN : la page doit fonctionner sur un
// réseau local sans accès Internet.
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist', 'presentation', 'vendor');
fs.mkdirSync(outDir, { recursive: true });

const files = [
  ['node_modules/@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['node_modules/@xterm/xterm/lib/xterm.js', 'xterm.js'],
  ['node_modules/@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js']
];
for (const [src, dest] of files) {
  fs.copyFileSync(path.join(root, src), path.join(outDir, dest));
}
console.log(`[screen2http] xterm copié dans ${outDir}`);
