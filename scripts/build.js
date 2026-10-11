'use strict';

// Builds the local UI into dist/renderer (git-ignored): the xterm.js bundle (JS + CSS) via
// esbuild, plus the static page and stylesheet. Source stays in src/renderer.
// Usage: node scripts/build.js [outDir]   (outDir is only overridden by tests)
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const outDir = path.resolve(process.argv[2] || path.join(ROOT, 'dist', 'renderer'));

async function build() {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: [path.join(SRC, 'terminal.js')],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outfile: path.join(outDir, 'terminal.bundle.js'),
    logLevel: 'warning'
  });
  for (const file of ['index.html', 'styles.css']) fs.copyFileSync(path.join(SRC, file), path.join(outDir, file));
  console.log(`renderer built -> ${path.relative(ROOT, outDir) || '.'}`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
