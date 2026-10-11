'use strict';

const path = require('node:path');
const { createStateObserver } = require('./state-observer');
const { createDiagnosticsLog } = require('./diagnostics');

const SUMMARY_MS = 30000;
const SNAPSHOT_DELAYS_MS = [3000, 20000];     // after a load / conversation change: SPA hydration, then a second look
const SNAPSHOT_LIMIT = 12;                    // per run: the log is evidence, not a stream

// Chat-state observation of ONE view's WebContents (the I3P detector and model, unchanged).
//   status mode (M01-I3B-2): `status: true`, used by the observation hub for every loaded view; reports the model through
//   `onChange` only when it meaningfully changes; no diagnostics log.
//   diagnostic mode: CONTEXTDECK_CHAT_OBSERVER=1; additionally logs to <userData>\diagnostics\chat-observer.jsonl (each
//   entry tagged with the view id):
//   transitions of the model, the shape of the send/stop controls when it changes, a summary every 30 s
//   (polls, lost/dropped results, how often each signal was true/false/unknown, how the composer was found)
//   and a sanitized structural snapshot of the page while the composer has not been found.
// Only indicators depend on it: no view lifecycle, binding, navigation or Herdr decision does. No message text is ever read out.
function startChatObservation({ contents, userDataDir, env = process.env, viewId = null, status = false, onChange: notify, phaseMs = 0, setTimer = setTimeout, clearTimer = clearTimeout, setRepeat = setInterval, clearRepeat = clearInterval }) {
  const diagnostics = env.CONTEXTDECK_CHAT_OBSERVER === '1';
  if (!diagnostics && !status) return null;
  if (!diagnostics) return createStateObserver({ contents, onChange: notify, phaseMs, setTimer, clearTimer });
  const log = createDiagnosticsLog({ file: path.join(userDataDir, 'diagnostics', 'chat-observer.jsonl'), tag: viewId });
  let lastControls = '';
  let composerSeen = false;
  let snapshots = 0;
  let timers = [];
  let counters = { composer: { t: 0, f: 0, n: 0 }, stop: { t: 0, f: 0, n: 0 }, draft: { t: 0, f: 0, n: 0 }, via: {} };

  const tally = (bucket, value) => { bucket[value === true ? 't' : value === false ? 'f' : 'n'] += 1; };

  function scheduleSnapshots(reason) {
    for (const delay of SNAPSHOT_DELAYS_MS) {
      const timer = setTimer(async () => {
        timers = timers.filter((t) => t !== timer);
        if (composerSeen || snapshots >= SNAPSHOT_LIMIT) return;
        snapshots += 1;
        const structure = await observer.snapshotStructure();
        log.note({ structure, reason, delayMs: delay });
      }, delay);
      timer.unref?.();
      timers.push(timer);
    }
  }

  const observer = createStateObserver({
    contents,
    diagnostic: true,
    phaseMs,
    onChange: (state, prev, event) => {
      log.transition(state, prev, event);
      notify?.(state, prev, event);
      // Every load or conversation change starts a new search for the composer.
      if ((event.type === 'page-ready' || event.type === 'navigated') && state.page === 'ready') { composerSeen = false; scheduleSnapshots(event.type); }
    },
    onProbe: ({ signals, via, controls, form }) => {
      if (signals) { tally(counters.composer, signals.composer); tally(counters.stop, signals.stop); tally(counters.draft, signals.draft); if (signals.composer === true) composerSeen = true; }
      if (via) counters.via[via] = (counters.via[via] || 0) + 1;
      // The shape of the controls is logged only when it changes (this is how the stop state is discovered).
      const text = JSON.stringify([controls || [], form || []]);
      if (text !== lastControls) { lastControls = text; log.note({ controls, form }); }
    }
  });

  const summary = setRepeat(() => {
    const state = observer.getState();
    log.note({ summary: { ...observer.getStats(), counters, page: state.page, identity: state.identity.kind, generation: state.generation.reason } });
    counters = { composer: { t: 0, f: 0, n: 0 }, stop: { t: 0, f: 0, n: 0 }, draft: { t: 0, f: 0, n: 0 }, via: {} };
  }, SUMMARY_MS);
  summary.unref?.();

  const stop = observer.stop;
  observer.stop = () => {
    clearRepeat(summary);
    for (const t of timers) clearTimer(t);
    timers = [];
    stop();
  };
  log.note({ started: true, electron: process.versions.electron });
  return observer;
}

module.exports = { startChatObservation, SNAPSHOT_DELAYS_MS, SNAPSHOT_LIMIT };
