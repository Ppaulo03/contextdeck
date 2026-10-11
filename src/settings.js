'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('config.json must contain an object');
  }
  const { herdrExecutable, herdrSession, workingDirectory } = value;
  if (typeof herdrExecutable !== 'string' || !herdrExecutable.trim()) {
    throw new Error('herdrExecutable must be a non-empty path or executable name');
  }
  if (typeof herdrSession !== 'string' || !SESSION_RE.test(herdrSession)) {
    throw new Error('herdrSession must contain 1-64 letters, digits, _ or -');
  }
  if (workingDirectory !== undefined && (typeof workingDirectory !== 'string' || !workingDirectory.trim())) {
    throw new Error('workingDirectory must be a non-empty path when provided');
  }
  return {
    herdrExecutable: herdrExecutable.trim(),
    herdrSession,
    workingDirectory: workingDirectory === undefined ? undefined : workingDirectory.trim()
  };
}

function loadSettings(projectRoot) {
  const configPath = path.join(projectRoot, 'config.json');
  const text = fs.readFileSync(configPath, 'utf8');
  return validateSettings(JSON.parse(text));
}

function isFile(candidate) {
  try { return fs.statSync(candidate).isFile(); } catch { return false; }
}

// Resolves the Herdr executable to an absolute path: an explicit path is checked as-is,
// a bare name is searched in PATH (honouring PATHEXT). Returns undefined when not found.
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

module.exports = { loadSettings, validateSettings, resolveExecutable };
