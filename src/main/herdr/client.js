'use strict';

const { resolveExecutable } = require('../platform/executable');
const { buildPtyEnv } = require('./env');

// The Herdr *client* running in a ConPTY. Killing it only detaches: the Herdr server and the
// agents it manages are separate processes and keep running.
function createHerdrClient({ settings, homeDir, send }) {
  let process_;

  function stop() {
    if (!process_) return;
    const previous = process_;
    process_ = undefined;
    try { previous.kill(); } catch { /* Client may have exited already. */ }
  }

  function start(cols, rows) {
    stop();
    if (process.platform !== 'win32') {
      return { ok: false, error: 'This package is scoped to native Windows.' };
    }
    const executable = resolveExecutable(settings.herdrExecutable);
    if (!executable) {
      return {
        ok: false,
        error: `Herdr nao encontrado ("${settings.herdrExecutable}"). Instale o Herdr ou ajuste herdrExecutable em config.json com o caminho completo.`
      };
    }
    try {
      // Lazy require allows the UI to show a readable error if the native module fails to load.
      const pty = require('node-pty');
      const proc = pty.spawn(executable, ['--session', settings.herdrSession], {
        name: 'xterm-256color',
        cols: Math.max(20, Math.min(500, Math.round(cols) || 100)),
        rows: Math.max(5, Math.min(200, Math.round(rows) || 30)),
        cwd: settings.workingDirectory || homeDir,
        env: buildPtyEnv(process.env)
      });
      process_ = proc;
      proc.onData((data) => {
        if (process_ === proc) send('pty:data', data);
      });
      proc.onExit(({ exitCode }) => {
        if (process_ === proc) {
          process_ = undefined;
          send('pty:exit', { exitCode });
        }
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    start,
    stop,
    isRunning: () => Boolean(process_),
    write: (text) => { if (process_) process_.write(text); },
    resize: (cols, rows) => { if (process_) { try { process_.resize(cols, rows); } catch { /* During exit. */ } } }
  };
}

module.exports = { createHerdrClient };
