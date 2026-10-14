'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const LOCAL_CONFIG = 'config.json';
const EXAMPLE_CONFIG = 'config.example.json';

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

// config.json is the local, git-ignored configuration. A fresh checkout has only the versioned
// config.example.json, which is used as-is until the user copies it to config.json.
function loadSettings(projectRoot) {
  const local = path.join(projectRoot, LOCAL_CONFIG);
  const file = fs.existsSync(local) ? local : path.join(projectRoot, EXAMPLE_CONFIG);
  return validateSettings(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { loadSettings, validateSettings, LOCAL_CONFIG, EXAMPLE_CONFIG };
