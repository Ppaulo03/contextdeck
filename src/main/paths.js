'use strict';

const path = require('node:path');

// Locations of the files the main process loads, relative to the project root. Source lives in
// src/; the built UI (git-ignored) lives in dist/ and is produced by `npm run build`.
const PROJECT_ROOT = path.join(__dirname, '..', '..');

module.exports = Object.freeze({
  PROJECT_ROOT,
  PRELOAD: path.join(PROJECT_ROOT, 'src', 'preload', 'index.js'),
  OVERLAY_PRELOAD: path.join(PROJECT_ROOT, 'src', 'preload', 'overlay.js'),
  RENDERER_HTML: path.join(PROJECT_ROOT, 'dist', 'renderer', 'index.html'),
  OVERLAY_HTML: path.join(PROJECT_ROOT, 'dist', 'renderer', 'overlay.html')
});
