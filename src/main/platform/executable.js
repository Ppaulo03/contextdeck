'use strict';

const fs = require('node:fs');
const path = require('node:path');

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

// Resolves an executable to an absolute path: an explicit path is checked as-is, a bare name is
// searched in PATH (honouring PATHEXT). Returns undefined when not found.
function resolveExecutable(name, env = process.env) {
  const exts = name.includes('.')
    ? ['']
    : ['', ...(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)];
  const hasDir = path.isAbsolute(name) || name.includes('/') || name.includes('\\');
  const dirs = hasDir ? [''] : (env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = dir ? path.join(dir, name + ext) : name + ext;
      if (isFile(candidate)) return path.resolve(candidate);
    }
  }
  return undefined;
}

module.exports = { resolveExecutable };
