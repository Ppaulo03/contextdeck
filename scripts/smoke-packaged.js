const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const executable = path.resolve(process.env.CONTEXTDECK_PACKAGED_EXECUTABLE || path.join(ROOT, 'dist', 'win', 'win-unpacked', 'ContextDeck.exe'));
if (!fs.existsSync(executable)) throw new Error('run npm run dist:dir before packaged smoke');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'contextdeck-packaged-'));
const child = spawn(executable, [], {
  cwd: ROOT,
  env: { ...process.env, CONTEXTDECK_USER_DATA: profile },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });
const waitMs = Number(process.env.CONTEXTDECK_PACKAGED_SMOKE_WAIT_MS || 15000);
const wait = new Promise((resolve) => setTimeout(resolve, waitMs));
function cleanup() {
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); return true; }
  catch { return false; }
}
Promise.race([wait, new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 1)))])
  .then((result) => {
    const exited = typeof result === 'number';
    if (exited) throw new Error(`packaged app exited during smoke (code ${result})\n${output}`);
    if (/uncaught|fatal|Error:/i.test(output)) throw new Error(`packaged app reported a startup error\n${output}`);
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    const cleaned = cleanup();
    console.log(JSON.stringify({ executable, waitMs, result: 'running', profileCleaned: cleaned }, null, 2));
  })
  .catch((error) => {
    if (child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    cleanup();
    console.error(error.message);
    process.exitCode = 1;
  });
