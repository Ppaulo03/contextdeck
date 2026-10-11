'use strict';

// Builds the local UI into dist/renderer (git-ignored). Source stays in src/renderer.
//   app.bundle.js/.css      the main window (xterm.js + components)
//   overlay.bundle.js       the workspace menu overlay
//   styles.css              design tokens + base + layout + components (@imports inlined)
//   index.html, overlay.html, overlay.css   copied as they are
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
    entryPoints: {
      'app.bundle': path.join(SRC, 'app.js'),
      'overlay.bundle': path.join(SRC, 'overlay', 'overlay.js')
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    outdir: outDir,
    logLevel: 'warning'
  });
  await esbuild.build({
    entryPoints: { styles: path.join(SRC, 'styles', 'index.css') },
    bundle: true,
    target: 'chrome120',
    outdir: outDir,
    logLevel: 'warning'
  });
  fs.copyFileSync(path.join(SRC, 'index.html'), path.join(outDir, 'index.html'));
  fs.copyFileSync(path.join(SRC, 'overlay', 'overlay.html'), path.join(outDir, 'overlay.html'));
  fs.copyFileSync(path.join(SRC, 'overlay', 'overlay.css'), path.join(outDir, 'overlay.css'));
  console.log(`renderer built -> ${path.relative(ROOT, outDir) || '.'}`);
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});
