'use strict';

// What is read from the ChatGPT page, and nothing else. The probe runs in an ISOLATED world: it sees the DOM
// but not the page's JavaScript, exposes no channel to the page, and returns only booleans. It never returns,
// logs or stores message text. The draft probe reads the length of the composer locally to answer "empty or
// not"; the text itself is discarded inside the probe.
//
// The selectors are CANDIDATES discovered on the logged-out page (see docs/validation/m01-i3p.md). The UI is
// not a contract: they change without notice and some are localized. `stop`, `turnActions`, `error` were not
// validated against a live response; the model therefore treats them as weak evidence.
const CANDIDATES = Object.freeze({
  composer: ['textarea[data-octane-input]', 'textarea[name="prompt"]', '#prompt-textarea', '[data-testid="prompt-textarea"]'],
  submit: ['[data-composer-submit]', '[data-testid="send-button"]', '[data-testid="stop-button"]'],
  stop: ['[data-testid="stop-button"]'],
  turnActions: ['[data-testid="copy-turn-action-button"]', '[data-testid="good-response-turn-action-button"]'],
  error: ['[role="alert"]']
});
const STOP_LABEL = '^(stop|parar|interromper|detener|arr[eê]ter|stopp)';
const STOP_VALUE = '^(stop|stopping|streaming|generating|responding)$';
const WORLD_ID = 1001;

// `diagnostic` additionally returns the state signature of the send/stop control (attribute names and short
// values, aria-label): UI chrome, not conversation content. It is how a manual run discovers which attribute
// flips while a response is being generated.
const probeSource = ({ diagnostic = false } = {}) => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  const first = (list) => { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; };
  const any = (list) => first(list) !== null;
  const visible = (e) => !!e && !e.hidden && e.getClientRects().length > 0;
  const composer = first(C.composer);
  const submit = first(C.submit);
  let stop = any(C.stop);
  if (!stop && submit) {
    const label = (submit.getAttribute('aria-label') || '');
    if (new RegExp(${JSON.stringify(STOP_LABEL)}, 'i').test(label)) stop = true;
    for (const a of submit.attributes) if (!/-label$/.test(a.name) && new RegExp(${JSON.stringify(STOP_VALUE)}, 'i').test(a.value)) stop = true;
  }
  const out = {
    composer: composer ? true : (document.body ? false : null),
    stop,
    turnActions: any(C.turnActions),
    error: [...document.querySelectorAll(C.error[0])].some(visible),
    interrupted: null,
    draft: composer ? ((composer.value !== undefined ? composer.value : composer.textContent) || '').trim().length > 0 : null
  };
  ${diagnostic ? "if (submit) out.controlSignature = { label: submit.getAttribute('aria-label') || '', attrs: [...submit.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => a.name + (a.value.length <= 24 ? '=' + a.value : '')).sort() };" : ''}
  return out;
})()`;

const SIGNAL_KEYS = ['composer', 'stop', 'turnActions', 'error', 'interrupted', 'draft'];
const tri = (v) => (v === true ? true : v === false ? false : null);

// The page is untrusted: accept only the expected booleans, anything else is "not determinable".
function normalizeSignals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const signals = {};
  for (const key of SIGNAL_KEYS) signals[key] = tri(raw[key]);
  return signals;
}

module.exports = { CANDIDATES, WORLD_ID, probeSource, normalizeSignals, SIGNAL_KEYS };
