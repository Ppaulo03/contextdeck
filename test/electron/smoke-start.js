'use strict';

// Real start-up smoke test (M01-I3B-3). NOT part of `npm test` (opens a window):
//     npm run smoke
// Unit tests never run src/main/index.js, so a wiring mistake there (a collaborator used before the window exists, a missing
// require) used to pass every test and only show when the application was started. This starts the REAL application on a
// throwaway profile (CONTEXTDECK_USER_DATA), waits, and requires: no "failed to start" message, no uncaught exception text, and
// the process still alive. It does not need Herdr, the network or a login, and it does not touch the real profile.
// Exit codes: 0 started and stayed up; 1 failed (output printed); 2 could not run (no built renderer).
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const WAIT_MS = Number(process.env.SMOKE_WAIT_MS) || 15000;
const electronPath = require('electron');

if (!fs.existsSync(path.join(ROOT, 'dist', 'renderer', 'index.html'))) {
  console.log('smoke-start: SKIPPED/BLOCKED: dist/renderer is missing; run "npm run build" first');
  process.exit(2);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-smoke-'));
let output = '';
const child = spawn(electronPath, ['.'], { cwd: ROOT, env: { ...process.env, CONTEXTDECK_USER_DATA: profile }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
child.stdout.on('data', (d) => { output += d; });
child.stderr.on('data', (d) => { output += d; });
let exited = null;
child.on('exit', (code, signal) => { exited = { code, signal }; });

function finish(code, message) {
  try { if (exited === null) execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* Already gone. */ }
  setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Best effort. */ } console.log(`smoke-start: ${message}`); process.exit(code); }, 800);
}

setTimeout(() => {
  const bad = /ContextDeck failed to start|Uncaught|TypeError|ReferenceError|Cannot find module/i.test(output);
  if (exited !== null) return finish(1, `FAILED: the application exited early (${JSON.stringify(exited)})\n${output.slice(-1500)}`);
  if (bad) return finish(1, `FAILED: errors while starting\n${output.slice(-1500)}`);
  finish(0, `ok: the real application started and was still running after ${WAIT_MS} ms (throwaway profile)`);
}, WAIT_MS);
