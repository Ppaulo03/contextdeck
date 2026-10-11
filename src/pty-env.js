'use strict';

// Builds the environment for the Herdr client PTY. Herdr exports HERDR_* variables
// (HERDR_ENV, HERDR_SOCKET_PATH, HERDR_PANE_ID...) inside its panes. If Project Dock is
// launched from one, inheriting them makes Herdr refuse to start ("nested herdr") and
// could point the client at the *outer* server's socket instead of the configured session.
function buildPtyEnv(baseEnv) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value !== undefined && !key.toUpperCase().startsWith('HERDR_')) env[key] = value;
  }
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

module.exports = { buildPtyEnv };
