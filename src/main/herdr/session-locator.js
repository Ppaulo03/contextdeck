'use strict';

const { execFile } = require('node:child_process');
const { resolveExecutable } = require('../platform/executable');
const { buildPtyEnv } = require('./env');

// Finds the API endpoint of a named Herdr session through the official CLI
// (`herdr session list --json`, read-only). The endpoint is never derived from folder conventions.

class SessionLocatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SessionLocatorError';
    this.code = code;
  }
}

// Pure: picks the entry for `session` out of the CLI's JSON output.
// Returns { socketPath, running } or throws SessionLocatorError('session_not_found' | 'invalid_output').
function parseSessionList(stdout, session) {
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { throw new SessionLocatorError('invalid_output', 'herdr session list did not return JSON'); }
  if (!parsed || !Array.isArray(parsed.sessions)) throw new SessionLocatorError('invalid_output', 'herdr session list returned an unexpected shape');
  const entry = parsed.sessions.find((s) => s && s.name === session);
  if (!entry) throw new SessionLocatorError('session_not_found', `Herdr session "${session}" does not exist`);
  if (typeof entry.socket_path !== 'string' || !entry.socket_path) throw new SessionLocatorError('invalid_output', 'session entry has no socket_path');
  return { socketPath: entry.socket_path, running: entry.running === true };
}

// Runs `herdr session list --json`. HERDR_* variables are stripped so the CLI never inherits an
// outer session's socket context. `exec` is injectable for tests.
function createSessionLocator({ herdrExecutable, exec = execFile, timeoutMs = 5000 }) {
  return function locate(session) {
    return new Promise((resolve, reject) => {
      const executable = resolveExecutable(herdrExecutable);
      if (!executable) return reject(new SessionLocatorError('herdr_not_found', `Herdr executable "${herdrExecutable}" was not found`));
      exec(executable, ['session', 'list', '--json'], { env: buildPtyEnv(process.env), windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new SessionLocatorError('cli_failed', `herdr session list failed: ${error.code || error.message}`));
        try { resolve(parseSessionList(String(stdout), session)); } catch (parseError) { reject(parseError); }
      });
    });
  };
}

module.exports = { createSessionLocator, parseSessionList, SessionLocatorError };
