'use strict';

// What is read from the ChatGPT page, and nothing else. The probes run in an ISOLATED world: they see the DOM
// but not the page's JavaScript, expose no channel to the page, and return only booleans, counts and short
// control attributes. They never return, log or store message text. The draft check reads the length of the
// composer locally to answer "empty or not"; the text itself is discarded inside the probe.
//
// The UI is not a contract. The composer is therefore located in tiers, from specific to structural, and the
// tier that matched is reported (`via`) so a failure can be diagnosed instead of guessed:
//   candidate   a known selector (textarea[data-octane-input], #prompt-textarea, ...)
//   structural  the last visible editable element (textarea / contenteditable / role=textbox) inside a <form>
//               that also holds a submit control
//   lone        the only visible editable element of the document
//   shadow      the same search inside open shadow roots
// The send/stop control is read from the composer's own form, not from a single selector. First live result:
// the candidate selectors found on the logged-OUT page matched nothing on the logged-in page, which is why
// the structural tiers exist (see docs/validation/m01-i3p.md).
const CANDIDATES = Object.freeze({
  composer: ['textarea[data-octane-input]', '[data-octane-input][contenteditable]', 'textarea[name="prompt"]', '#prompt-textarea', '[data-testid="prompt-textarea"]'],
  submit: ['[data-composer-submit]', '[data-testid="send-button"]', '[data-testid="stop-button"]'],
  stop: ['[data-testid="stop-button"]'],
  turnActions: ['[data-testid="copy-turn-action-button"]', '[data-testid="good-response-turn-action-button"]'],
  error: ['[role="alert"]']
});
const EDITABLE = 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
const SUBMIT_IN_FORM = 'button[type="submit"], [data-composer-submit], [data-testid="send-button"], [data-testid="stop-button"]';
const STOP_LABEL = '^(stop|parar|interromper|detener|arr[eê]ter|stopp)';
const STOP_VALUE = '^(stop|stopping|streaming|generating|responding)$';
const WORLD_ID = 1001;
const SHADOW_SCAN_LIMIT = 5000;

// Shared by both probes: tiered composer lookup. Returns { composer, via }.
const FIND_COMPOSER = `
  const first = (list) => { for (const s of list) { const e = document.querySelector(s); if (e) return e; } return null; };
  const visible = (e) => !!e && !e.hidden && e.getClientRects().length > 0;
  const findComposer = () => {
    const known = first(C.composer);
    if (known) return { composer: known, via: 'candidate' };
    const editable = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})].filter(visible);
    let inForm = null;
    for (const e of editable) {
      const form = e.closest ? e.closest('form') : null;
      if (form && form.querySelector(${JSON.stringify(SUBMIT_IN_FORM)})) inForm = e;   // the composer is the last one: edit boxes of earlier messages come before it
    }
    if (inForm) return { composer: inForm, via: 'structural' };
    if (editable.length === 1) return { composer: editable[0], via: 'lone' };
    let scanned = 0;
    for (const host of document.querySelectorAll('*')) {
      if (++scanned > ${SHADOW_SCAN_LIMIT}) break;
      const root = host.shadowRoot;
      if (!root) continue;
      const e = [...root.querySelectorAll(${JSON.stringify(EDITABLE)})].filter(visible).pop();
      if (e) return { composer: e, via: 'shadow' };
    }
    return { composer: null, via: null };
  };`;

// The send/stop control(s): the known ones plus every button of the composer's own form.
const FIND_CONTROLS = `
  const controls = (composer) => {
    const out = [];
    for (const s of C.submit) { const e = document.querySelector(s); if (e && !out.includes(e)) out.push(e); }
    const form = composer && composer.closest ? composer.closest('form') : null;
    if (form) for (const b of [...form.querySelectorAll('button')].slice(0, 20)) if (!out.includes(b)) out.push(b);
    return out;
  };
  const stopLike = (b) => {
    const label = b.getAttribute('aria-label') || '';
    if (new RegExp(${JSON.stringify(STOP_LABEL)}, 'i').test(label)) return true;
    if (/stop/i.test(b.getAttribute('data-testid') || '')) return true;
    for (const a of b.attributes) if (!/-label$/.test(a.name) && new RegExp(${JSON.stringify(STOP_VALUE)}, 'i').test(a.value)) return true;
    return false;
  };`;

// `diagnostic` additionally returns how the composer was found and the state signature of the form's buttons
// (attribute names, short values; labels only for submit-like or test-id controls): UI chrome, not content.
const probeSource = ({ diagnostic = false } = {}) => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  ${FIND_CONTROLS}
  const any = (list) => first(list) !== null;
  const { composer, via } = findComposer();
  const buttons = controls(composer);
  const stop = any(C.stop) || buttons.some(stopLike);
  const out = {
    composer: composer ? true : (document.body ? false : null),
    stop,
    turnActions: any(C.turnActions),
    error: [...document.querySelectorAll(C.error[0])].some(visible),
    interrupted: null,
    draft: composer ? ((composer.value !== undefined ? composer.value : composer.textContent) || '').trim().length > 0 : null
  };
  ${diagnostic ? `out.via = via;
  const sig = (b) => {
    const named = b.type === 'submit' || b.hasAttribute('data-testid') || [...b.attributes].some((a) => /^data-composer/.test(a.name));
    const label = b.getAttribute('aria-label') || '';
    return { type: b.type || '', testid: b.getAttribute('data-testid') || '', label: named && label.length <= 40 ? label : '', attrs: [...b.attributes].filter((a) => !/^(class|style|id)$/.test(a.name)).map((a) => a.name + (named && a.value.length <= 24 ? '=' + a.value : '')).sort().slice(0, 24) };
  };
  out.controls = buttons.slice(0, 8).map(sig);
  // The composer form itself carries state attributes on the live page (data-announcement-*, data-logged-out, ...):
  // its attribute values are UI chrome and are logged whenever they change.
  const form = composer && composer.closest ? composer.closest('form') : null;
  out.form = form ? [...form.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => a.name + (a.value.length <= 40 ? '=' + a.value : '')).sort().slice(0, 30) : [];` : ''}
  return out;
})()`;

// One-shot structural snapshot for diagnosing a page we do not understand yet. Counts and control attributes
// only: no text content, no values, no attribute values from anything outside the composer's own form.
const structureSource = () => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  const cut = (v) => String(v).slice(0, 40);
  const attrs = (e, valued) => [...e.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => cut(a.name) + (valued.has(a.name) && a.value.length <= 40 ? '=' + a.value : '')).slice(0, 30);
  const VALUED = new Set(['id', 'role', 'type', 'name', 'contenteditable', 'data-testid', 'enterkeyhint']);
  const editable = [...document.querySelectorAll(${JSON.stringify(EDITABLE)})];
  const { composer, via } = findComposer();
  const form = composer && composer.closest ? composer.closest('form') : null;
  let shadowHosts = 0, scanned = 0;
  for (const host of document.querySelectorAll('*')) { if (++scanned > ${SHADOW_SCAN_LIMIT}) break; if (host.shadowRoot) shadowHosts++; }
  return {
    readyState: document.readyState,
    hasBody: !!document.body,
    forms: document.querySelectorAll('form').length,
    iframes: document.querySelectorAll('iframe').length,
    shadowHosts,
    scannedElements: scanned,
    editable: editable.slice(0, 6).map((e) => ({ tag: e.tagName, visible: visible(e), inForm: !!(e.closest && e.closest('form')), attrs: attrs(e, VALUED), children: e.children.length })),
    composer: { found: !!composer, via, tag: composer ? composer.tagName : null, attrs: composer ? attrs(composer, VALUED) : [] },
    form: form ? {
      attrs: [...form.attributes].filter((a) => !/^(class|style)$/.test(a.name)).map((a) => cut(a.name) + (a.value.length <= 40 ? '=' + a.value : '')).slice(0, 30),
      buttons: [...form.querySelectorAll('button')].slice(0, 12).map((b) => {
        const named = b.type === 'submit' || b.hasAttribute('data-testid') || [...b.attributes].some((a) => /^data-composer/.test(a.name));
        const label = b.getAttribute('aria-label') || '';
        return { type: b.type || '', testid: b.getAttribute('data-testid') || '', visible: visible(b), disabled: !!b.disabled, label: named && label.length <= 40 ? label : '', attrs: attrs(b, named ? new Set([...VALUED, 'aria-label', 'aria-disabled', 'data-state']) : VALUED) };
      })
    } : null,
    testids: [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => cut(e.getAttribute('data-testid'))))].sort().slice(0, 60),
    known: Object.fromEntries(Object.entries(C).map(([k, list]) => [k, list.map((s) => document.querySelectorAll(s).length)]))
  };
})()`;

const SIGNAL_KEYS = ['composer', 'stop', 'turnActions', 'error', 'interrupted', 'draft'];
const tri = (v) => (v === true ? true : v === false ? false : null);
const VIA = new Set(['candidate', 'structural', 'lone', 'shadow']);

// The page is untrusted: accept only the expected booleans, anything else is "not determinable".
function normalizeSignals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const signals = {};
  for (const key of SIGNAL_KEYS) signals[key] = tri(raw[key]);
  return signals;
}

const safeText = (v, max = 40) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, max) : '');
const safeList = (v, limit, map) => (Array.isArray(v) ? v.slice(0, limit).map(map) : []);
const safeInt = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e6, Math.trunc(v))) : 0);

// Re-builds a probe/structure result from scratch with bounded strings and lists, so whatever the page (or a
// bug) put there can only ever be short control metadata.
function sanitizeControls(list) {
  return safeList(list, 8, (c) => ({
    type: safeText(c && c.type, 16), testid: safeText(c && c.testid), label: safeText(c && c.label),
    attrs: safeList(c && c.attrs, 24, (a) => safeText(a, 70))
  }));
}

function sanitizeProbe(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return { via: VIA.has(raw.via) ? raw.via : null, controls: sanitizeControls(raw.controls), form: safeList(raw.form, 30, (a) => safeText(a, 70)) };
}

function sanitizeStructure(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const attrs = (a) => safeList(a, 30, (x) => safeText(x, 70));
  const form = raw.form && typeof raw.form === 'object' ? {
    attrs: attrs(raw.form.attrs),
    buttons: safeList(raw.form.buttons, 12, (b) => ({ type: safeText(b && b.type, 16), testid: safeText(b && b.testid), visible: b && b.visible === true, disabled: b && b.disabled === true, label: safeText(b && b.label), attrs: attrs(b && b.attrs) }))
  } : null;
  const known = {};
  if (raw.known && typeof raw.known === 'object') for (const key of Object.keys(CANDIDATES)) known[key] = safeList(raw.known[key], 8, safeInt);
  return {
    readyState: safeText(raw.readyState, 16), hasBody: raw.hasBody === true,
    forms: safeInt(raw.forms), iframes: safeInt(raw.iframes), shadowHosts: safeInt(raw.shadowHosts), scannedElements: safeInt(raw.scannedElements),
    editable: safeList(raw.editable, 6, (e) => ({ tag: safeText(e && e.tag, 16), visible: e && e.visible === true, inForm: e && e.inForm === true, attrs: attrs(e && e.attrs), children: safeInt(e && e.children) })),
    composer: { found: !!(raw.composer && raw.composer.found), via: raw.composer && VIA.has(raw.composer.via) ? raw.composer.via : null, tag: safeText(raw.composer && raw.composer.tag, 16), attrs: attrs(raw.composer && raw.composer.attrs) },
    form,
    testids: safeList(raw.testids, 60, (t) => safeText(t)),
    known
  };
}

module.exports = { CANDIDATES, WORLD_ID, probeSource, structureSource, normalizeSignals, sanitizeProbe, sanitizeStructure, SIGNAL_KEYS };
