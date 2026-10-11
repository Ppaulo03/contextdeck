'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 1024 * 1024;

// Append-only JSONL log of state TRANSITIONS for the manual experiments (development only, off by default).
// No conversation content: ids are reduced to a short hash, signatures are UI control attributes. It is
// diagnostic evidence, never read back as state and never used to restore anything after a restart.
const shortHash = (value) => crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);

// `tag` (a view id) marks the entries of one view when several views share the file.
function createDiagnosticsLog({ file, tag = null, now = Date.now, maxBytes = MAX_BYTES }) {
  let written = 0;
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); written = fs.existsSync(file) ? fs.statSync(file).size : 0; } catch { /* Logging is best effort. */ }

  function write(entry) {
    try {
      if (written > maxBytes) { fs.renameSync(file, `${file}.1`); written = 0; }
      const line = `${JSON.stringify({ t: now(), ...(tag ? { view: tag } : {}), ...entry })}\n`;
      fs.appendFileSync(file, line);
      written += line.length;
    } catch { /* Never let diagnostics affect the app. */ }
  }

  return {
    transition(state, prev, event) {
      write({
        event: event.type,
        epoch: state.epoch,
        page: state.page,
        identity: { kind: state.identity.kind, h: shortHash(state.identity.key) },
        generation: state.generation,
        draft: state.draft,
        visible: state.visible,
        attention: state.attention.pending,
        from: { generation: prev.generation.state, draft: prev.draft.state }
      });
    },
    note: (entry) => write({ note: true, ...entry }),
    file
  };
}

module.exports = { createDiagnosticsLog, shortHash };
