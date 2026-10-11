'use strict';

const path = require('node:path');
const { createStateObserver } = require('./state-observer');
const { createDiagnosticsLog } = require('./diagnostics');

// Experimental chat-state observation (M01-I3P). Disabled unless CONTEXTDECK_CHAT_OBSERVER=1; when enabled it
// only logs transitions to <userData>\diagnostics\chat-observer.jsonl. Nothing in the UI, the lifecycle of
// the view or any decision depends on it.
function startChatObservation({ contents, userDataDir, env = process.env }) {
  if (env.CONTEXTDECK_CHAT_OBSERVER !== '1') return null;
  const log = createDiagnosticsLog({ file: path.join(userDataDir, 'diagnostics', 'chat-observer.jsonl') });
  let lastControl = '';
  const observer = createStateObserver({
    contents,
    diagnostic: true,
    onChange: (state, prev, event) => log.transition(state, prev, event),
    onProbe: ({ control }) => {
      // The signature of the send/stop control is logged only when it changes.
      const text = control ? JSON.stringify(control) : '';
      if (text !== lastControl) { lastControl = text; log.note({ control }); }
    }
  });
  log.note({ started: true, electron: process.versions.electron });
  return observer;
}

module.exports = { startChatObservation };
