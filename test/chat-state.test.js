'use strict';

// M01-I3P: the chat-state model, the probe contract and the observer (against a fake WebContents).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PAGE, GEN, DRAFT, EVIDENCE, END_CONFIRMATIONS, UNUSABLE_LIMIT, BUSY_ONLY_LIMIT, createState, reduce, parseConversationIdentity, lifecycleAdvice } = require('../src/main/chat/state-model');
const { probeSource, normalizeSignals, CANDIDATES } = require('../src/main/chat/state-detector');
const { createStateObserver } = require('../src/main/chat/state-observer');
const { createDiagnosticsLog, shortHash } = require('../src/main/chat/diagnostics');
const { startChatObservation } = require('../src/main/chat');

const CONV_A = 'https://chatgpt.com/c/11111111-aaaa-bbbb-cccc-000000000001';
const CONV_B = 'https://chatgpt.com/c/22222222-aaaa-bbbb-cccc-000000000002';
const PROJECT_CONV = 'https://chatgpt.com/g/g-p-0123456789abcdef-demo/c/33333333-aaaa-bbbb-cccc-000000000003';

const sig = (over = {}) => ({ composer: true, stop: false, stopWide: false, busy: false, turnActions: false, error: false, interrupted: null, draft: false, ...over });

// A response end needs END_CONFIRMATIONS consecutive confirming observations (M01-I3B-2R): this repeats one.
function settle(h, signals, n = END_CONFIRMATIONS) { for (let i = 0; i < n; i += 1) h.observe(signals); return h.state; }

// Drives the reducer like the observer does: the epoch is the one current when the probe was requested.
function harness() {
  let state = createState();
  let seq = 0;
  const api = {
    get state() { return state; },
    dispatch(event) { state = reduce(state, event); return state; },
    load(url) {
      api.dispatch({ type: 'page-loading' }); api.dispatch({ type: 'navigated', url, inPage: false }); api.dispatch({ type: 'page-ready' });
      return state;
    },
    observe(signals, { epoch = state.epoch, at } = {}) { seq += 1; return api.dispatch({ type: 'signals', epoch, seq: at ?? seq, signals }); },
    nextSeq: () => seq + 1
  };
  return api;
}

// ---- identity ------------------------------------------------------------------------------------

test('identity comes only from the URL: conversation, project conversation, new, other, unknown', () => {
  assert.deepEqual(parseConversationIdentity(CONV_A), { kind: 'conversation', id: '11111111-aaaa-bbbb-cccc-000000000001', key: 'c:11111111-aaaa-bbbb-cccc-000000000001' });
  assert.equal(parseConversationIdentity(PROJECT_CONV).kind, 'project-conversation');
  assert.equal(parseConversationIdentity(PROJECT_CONV).project, 'g-p-0123456789abcdef-demo');
  assert.equal(parseConversationIdentity('https://chatgpt.com/').kind, 'new');
  assert.equal(parseConversationIdentity('https://chatgpt.com/?temporary-chat=true').kind, 'new');
  assert.equal(parseConversationIdentity('https://chatgpt.com/g/g-p-0123456789abcdef-demo/project').kind, 'other');
  assert.equal(parseConversationIdentity('https://chatgpt.com/c/../../x').kind, 'other');
  assert.equal(parseConversationIdentity('https://auth.openai.com/c/11111111-aaaa').kind, 'other');
  assert.equal(parseConversationIdentity('not a url').kind, 'unknown');
  assert.equal(parseConversationIdentity('http://chatgpt.com/c/11111111-aaaa').kind, 'unknown');
  assert.equal(parseConversationIdentity('javascript:alert(1)').kind, 'unknown');
});

// ---- generation ------------------------------------------------------------------------------------

test('initial and loading states are unknown; nothing is claimed before signals arrive', () => {
  const h = harness();
  assert.equal(h.state.page, PAGE.UNLOADED);
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
  h.dispatch({ type: 'page-loading' });
  assert.equal(h.state.page, PAGE.LOADING);
  h.dispatch({ type: 'page-ready' });
  assert.equal(h.state.page, PAGE.READY);
  assert.equal(h.state.generation.state, GEN.UNKNOWN, 'ready is not idle');
});

test('idle -> responding -> completed needs corroboration; the stop control vanishing alone is not "completed"', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig());
  assert.deepEqual(h.state.generation, { state: GEN.IDLE, evidence: EVIDENCE.INFERRED, reason: 'composer-ready-no-stop' });
  h.observe(sig({ stop: true }));
  assert.deepEqual(h.state.generation, { state: GEN.RESPONDING, evidence: EVIDENCE.OBSERVED, reason: 'stop-control' });
  h.observe(sig({ stop: false }));
  assert.equal(h.state.generation.state, GEN.RESPONDING, 'one quiet observation is not an end');
  assert.equal(h.state.generation.reason, 'end-unconfirmed');
  settle(h, sig({ stop: false }), END_CONFIRMATIONS - 1);
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.generation.reason, 'ended-unclassified');
  // sticky: a later quiet poll does not rewrite it to idle
  h.observe(sig({ stop: false }));
  assert.equal(h.state.generation.reason, 'ended-unclassified');
  h.observe(sig({ stop: true }));
  settle(h, sig({ stop: false, turnActions: true }));
  assert.deepEqual(h.state.generation, { state: GEN.COMPLETED, evidence: EVIDENCE.INFERRED, reason: 'stop-gone+turn-actions' });
  h.observe(sig({ turnActions: true }));
  assert.equal(h.state.generation.state, GEN.COMPLETED, 'completed is sticky');
  h.observe(sig({ stop: true }));
  assert.equal(h.state.generation.state, GEN.RESPONDING, 'a new response replaces it');
});

test('interruption and failure: only explicit signals classify; otherwise unknown', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }));
  settle(h, sig({ stop: false, interrupted: true }));
  assert.equal(h.state.generation.state, GEN.INTERRUPTED);
  const g = harness(); g.load(CONV_A);
  g.observe(sig({ stop: true }));
  settle(g, sig({ stop: false, error: true }));
  assert.equal(g.state.generation.state, GEN.ERROR);
  const k = harness(); k.load(CONV_A);
  k.observe(sig({ stop: true }));
  settle(k, sig({ stop: false, composer: false }), Math.min(UNUSABLE_LIMIT, 100) - 1);
  assert.equal(k.state.generation.state, GEN.RESPONDING, 'composer disappeared with the stop control: could be navigation; still uncertain');
  assert.equal(k.state.generation.reason, 'signals-unusable');
  k.observe(sig({ stop: false, composer: false }));
  assert.equal(k.state.generation.state, GEN.UNKNOWN, 'a long run of nothing usable stops claiming a response');
  assert.equal(k.state.generation.reason, 'uncertain-timeout');
  assert.equal(k.state.attention.pending, false);
});

test('ambiguous signals never produce a confident state', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: null }));
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  h.observe(sig({ composer: null }));
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  h.observe(sig({ composer: false }));
  assert.equal(h.state.generation.reason, 'composer-missing');
});

test('signal loss while responding is held as uncertain, then given up as unknown; never an ending', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }));
  h.dispatch({ type: 'signals-lost', epoch: h.state.epoch });
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  assert.equal(h.state.generation.evidence, EVIDENCE.INFERRED);
  assert.equal(h.state.generation.reason, 'signals-unusable');
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
  for (let i = 1; i < Math.min(UNUSABLE_LIMIT, 100); i += 1) h.dispatch({ type: 'signals-lost', epoch: h.state.epoch });
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.generation.reason, 'uncertain-timeout');
  assert.equal(h.state.attention.pending, false);
});

// ---- draft ---------------------------------------------------------------------------------------

test('draft is observed independently of generation and never mixed into it', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ draft: true }));
  assert.deepEqual(h.state.draft, { state: DRAFT.PRESENT, evidence: EVIDENCE.OBSERVED });
  assert.equal(h.state.generation.state, GEN.IDLE);
  h.observe(sig({ draft: false }));
  assert.equal(h.state.draft.state, DRAFT.EMPTY);
  h.observe(sig({ draft: null }));
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
});

// ---- identity changes, reload, destroy -----------------------------------------------------------

test('navigating to another conversation resets everything learned: no state leaks across conversations', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true, draft: true }));
  h.dispatch({ type: 'navigated', url: CONV_B, inPage: true });
  assert.equal(h.state.identity.id, '22222222-aaaa-bbbb-cccc-000000000002');
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.generation.reason, 'identity-changed');
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
  assert.equal(h.state.attention.pending, false);
});

test('a probe requested before a navigation cannot be attributed to the conversation navigated to', () => {
  const h = harness(); h.load(CONV_A);
  const staleEpoch = h.state.epoch;
  h.dispatch({ type: 'navigated', url: CONV_B, inPage: true });
  h.observe(sig({ stop: true, draft: true }), { epoch: staleEpoch });
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
  h.observe(sig());
  assert.equal(h.state.generation.state, GEN.IDLE);
});

test('a new chat that gets its durable id while responding keeps responding; otherwise it resets', () => {
  const h = harness(); h.load('https://chatgpt.com/');
  h.observe(sig({ stop: true }));
  h.dispatch({ type: 'navigated', url: CONV_A, inPage: true });
  assert.equal(h.state.identity.kind, 'conversation');
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  const g = harness(); g.load('https://chatgpt.com/');
  g.observe(sig());
  g.dispatch({ type: 'navigated', url: CONV_A, inPage: true });
  assert.equal(g.state.generation.state, GEN.UNKNOWN, 'no response in progress: nothing is carried over');
});

test('navigation to a non-conversation page leaves identity "other" and generation unknown', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }));
  h.dispatch({ type: 'navigated', url: 'https://chatgpt.com/library', inPage: true });
  assert.equal(h.state.identity.kind, 'other');
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
});

test('reload invalidates transient state: responding is never kept across a page load', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true, draft: true }));
  h.dispatch({ type: 'page-loading' });
  assert.equal(h.state.page, PAGE.LOADING);
  assert.equal(h.state.identity.kind, 'unknown');
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.draft.state, DRAFT.UNKNOWN);
  h.observe(sig({ stop: true }));               // signals while loading are ignored
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
});

test('load failure and renderer crash end in error with unknown generation; destroyed is terminal', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }));
  h.dispatch({ type: 'page-failed' });
  assert.equal(h.state.page, PAGE.ERROR);
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  h.dispatch({ type: 'page-ready' });
  assert.equal(h.state.page, PAGE.ERROR, 'a stop-loading after a failure does not make it ready');
  h.load(CONV_A);
  h.dispatch({ type: 'page-crashed' });
  assert.equal(h.state.generation.reason, 'renderer-gone');
  h.dispatch({ type: 'page-destroyed' });
  const frozen = h.state;
  assert.equal(h.state.page, PAGE.DESTROYED);
  h.dispatch({ type: 'page-loading' }); h.observe(sig({ stop: true })); h.dispatch({ type: 'visibility', visible: true });
  assert.equal(h.state, frozen, 'nothing resurrects a destroyed view');
});

// ---- duplicates, ordering --------------------------------------------------------------------------

test('duplicate and out-of-order observations are ignored; unchanged signals return the same state object', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }), { at: 5 });
  const before = h.state;
  h.observe(sig({ stop: true }), { at: 6 });
  assert.equal(h.state.generation, before.generation, 'same generation object kept');
  h.observe(sig({ stop: false, turnActions: true }), { at: 4 });   // older than 6
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.observe(sig({ stop: false, turnActions: true }), { at: 6 });   // duplicate seq
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.dispatch({ type: 'visibility', visible: false });
  const same = h.state;
  assert.equal(h.dispatch({ type: 'visibility', visible: false }), same, 'idempotent');
  assert.equal(h.dispatch({ type: 'unknown-event' }), same);
});

// ---- attention and background -------------------------------------------------------------------------

test('a response that ends while the view is hidden raises attention; viewing clears it; no content involved', () => {
  const h = harness(); h.load(CONV_A);
  h.dispatch({ type: 'visibility', visible: true });
  h.observe(sig({ stop: true }));
  h.dispatch({ type: 'visibility', visible: false });
  settle(h, sig({ stop: false, turnActions: true }), END_CONFIRMATIONS - 1);
  assert.equal(h.state.attention.pending, false, 'an unconfirmed end raises no attention');
  h.observe(sig({ stop: false, turnActions: true }));
  assert.deepEqual(h.state.attention, { pending: true, reason: 'response-ended-in-background' });
  h.dispatch({ type: 'visibility', visible: true });
  assert.equal(h.state.attention.pending, true, 'becoming visible is not the same as having seen the response');
  h.dispatch({ type: 'viewed' });
  assert.equal(h.state.attention.pending, false);
  // ended while visible: no attention
  h.observe(sig({ stop: true }));
  settle(h, sig({ stop: false, turnActions: true }));
  assert.equal(h.state.attention.pending, false);
});

test('an unclassified end in the background also raises attention; a lost signal does not', () => {
  const h = harness(); h.load(CONV_A);
  h.observe(sig({ stop: true }));
  settle(h, sig({ stop: false }));
  assert.equal(h.state.generation.reason, 'ended-unclassified');
  assert.equal(h.state.attention.pending, true);
  const g = harness(); g.load(CONV_A);
  g.observe(sig({ stop: true }));
  g.dispatch({ type: 'signals-lost', epoch: g.state.epoch });
  assert.equal(g.state.attention.pending, false);
});

// ---- lifecycle advice ----------------------------------------------------------------------------------

test('lifecycle advice preserves by default and is evictable only when every dimension is positively quiet', () => {
  const h = harness();
  assert.equal(lifecycleAdvice(h.state).evictable, false);
  h.load(CONV_A);
  assert.ok(lifecycleAdvice(h.state).preserve.includes('generation-unknown'));
  h.observe(sig());
  assert.deepEqual(lifecycleAdvice(h.state), { evictable: true, preserve: [] });
  h.observe(sig({ draft: true }));
  assert.deepEqual(lifecycleAdvice(h.state).preserve, ['draft-present']);
  h.observe(sig({ draft: null }));
  assert.deepEqual(lifecycleAdvice(h.state).preserve, ['draft-unknown']);
  h.observe(sig({ stop: true }));
  assert.ok(lifecycleAdvice(h.state).preserve.includes('responding'));
  settle(h, sig({ stop: false, turnActions: true }));
  assert.ok(lifecycleAdvice(h.state).preserve.includes('unviewed-response'), 'a finished but unseen response is preserved');
  h.dispatch({ type: 'viewed' });
  assert.equal(lifecycleAdvice(h.state).evictable, true, 'completed alone is not a reason to keep, nor a license to destroy');
  h.dispatch({ type: 'visibility', visible: true });
  assert.ok(lifecycleAdvice(h.state).preserve.includes('visible'));
  const n = harness(); n.load('https://chatgpt.com/'); n.observe(sig());
  assert.ok(lifecycleAdvice(n.state).preserve.includes('identity-not-restorable'));
  const e = harness(); e.load(CONV_A); e.dispatch({ type: 'page-failed' });
  assert.ok(lifecycleAdvice(e.state).preserve.includes('page-error'));
});

// ---- the probe ---------------------------------------------------------------------------------------

function runProbe(document, options) {
  return vm.runInNewContext(probeSource(options), { document });
}
function fakeElement(attrs = {}, extra = {}) {
  return {
    hidden: false,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    getClientRects: () => [1],
    ...extra
  };
}
function fakeDocument(map) {
  return { body: {}, querySelector: (s) => map[s] || null, querySelectorAll: (s) => (map[s] ? [].concat(map[s]) : []) };
}

test('probe returns only booleans/null and never message text, even when the composer holds text', () => {
  const secret = 'PRIVATE PROMPT TEXT';
  const composer = fakeElement({}, { value: secret });
  const out = runProbe(fakeDocument({ 'textarea[data-octane-input]': composer }));
  assert.equal(out.draft, true);
  for (const value of Object.values(out)) assert.ok(value === true || value === false || value === null, 'only tri-state values');
  assert.doesNotMatch(JSON.stringify(out), /PRIVATE/);
  assert.equal(runProbe(fakeDocument({ 'textarea[data-octane-input]': fakeElement({}, { value: '   ' }) })).draft, false);
  assert.equal(runProbe(fakeDocument({})).draft, null, 'no composer: draft not determinable');
  assert.equal(runProbe(fakeDocument({})).composer, false);
  assert.equal(runProbe({ body: null, querySelector: () => null, querySelectorAll: () => [] }).composer, null);
});

test('probe detects a stop control by test id, by localized label, and by a state attribute (not by the permanent *-label attributes)', () => {
  const composer = fakeElement({}, { value: '' });
  const base = { 'textarea[data-octane-input]': composer };
  assert.equal(runProbe(fakeDocument({ ...base, '[data-testid="stop-button"]': fakeElement() })).stop, true);
  assert.equal(runProbe(fakeDocument({ ...base, '[data-composer-submit]': fakeElement({ 'aria-label': 'Parar de gerar' }) })).stop, true);
  assert.equal(runProbe(fakeDocument({ ...base, '[data-composer-submit]': fakeElement({ 'aria-label': 'Enviar mensagem', 'data-send-label': 'Enviar', 'data-stop-label': 'stop' }) })).stop, false, 'both captions live on the control at all times');
  assert.equal(runProbe(fakeDocument({ ...base, '[data-composer-submit]': fakeElement({ 'aria-label': 'x', 'data-state': 'streaming' }) })).stop, true);
});

test('probe: error uses only visible alerts; interrupted is never claimed (no known signal)', () => {
  const doc = fakeDocument({ 'textarea[data-octane-input]': fakeElement({}, { value: '' }), '[role="alert"]': [fakeElement({}, { getClientRects: () => [] })] });
  assert.equal(runProbe(doc).error, false);
  const shown = fakeDocument({ 'textarea[data-octane-input]': fakeElement({}, { value: '' }), '[role="alert"]': [fakeElement()] });
  assert.equal(runProbe(shown).error, true);
  assert.equal(runProbe(shown).interrupted, null);
});

test('diagnostic probe reports how the composer was found and the shape of the buttons, never text', () => {
  const submit = fakeElement({ 'aria-label': 'Enviar mensagem', class: 'x', 'data-composer-submit': '', 'data-state': 'idle', type: 'submit' }, { type: 'submit', hasAttribute: (n) => n === 'data-composer-submit' });
  const out = runProbe(fakeDocument({ 'textarea[data-octane-input]': fakeElement({}, { value: 'secret' }), '[data-composer-submit]': submit }), { diagnostic: true });
  assert.equal(out.via, 'candidate');
  assert.equal(out.controls.length, 1);
  assert.equal(out.controls[0].label, 'Enviar mensagem');
  assert.deepEqual(JSON.parse(JSON.stringify(out.controls[0].attrs)), ['aria-label=Enviar mensagem', 'data-composer-submit=', 'data-state=idle', 'type=submit']);
  assert.doesNotMatch(JSON.stringify(out), /secret/);
  const plain = runProbe(fakeDocument({}));
  assert.equal(plain.via, undefined, 'the plain probe adds nothing');
  assert.equal(plain.controls, undefined);
});

test('normalizeSignals accepts only booleans from the untrusted page', () => {
  assert.equal(normalizeSignals(null), null);
  assert.equal(normalizeSignals('x'), null);
  assert.deepEqual(normalizeSignals({ composer: 'yes', stop: 1, turnActions: true, error: false, draft: {}, extra: 'ignored' }),
    { composer: null, stop: null, stopWide: null, busy: null, turnActions: true, error: false, interrupted: null, draft: null });
  assert.ok(Object.keys(CANDIDATES).length >= 5);
});

// ---- observer against a fake WebContents --------------------------------------------------------------

function fakeContents({ url = '', loading = false } = {}) {
  const c = new EventEmitter();
  c.url = url; c.loading = loading; c.destroyed = false; c.calls = []; c.reply = () => sig();
  c.getURL = () => c.url;
  c.isLoading = () => c.loading;
  c.isDestroyed = () => c.destroyed;
  c.executeJavaScriptInIsolatedWorld = async (world, scripts) => { c.calls.push([world, scripts.length]); const r = c.reply(); if (r instanceof Error) throw r; return r; };
  return c;
}
const flush = () => new Promise((r) => setImmediate(r));
const listenerTotal = (c) => c.eventNames().reduce((n, name) => n + c.listenerCount(name), 0);

function manualTimers() {
  const pending = [];
  return {
    setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; pending.push(t); return t; },
    clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); },
    pending,
    async fire() { const t = pending.shift(); if (t) { t.fn(); await flush(); } return t; }
  };
}

function loadPage(c, url) {
  c.loading = true; c.emit('did-start-loading'); c.emit('did-start-navigation', {}, url, false, true);
  c.url = url; c.emit('did-navigate', {}, url);
  c.loading = false; c.emit('did-stop-loading');
}

test('observer: emits only on change, polls in an isolated world, adapts the interval, and never polls before ready', async () => {
  const c = fakeContents(); const t = manualTimers(); const changes = [];
  const o = createStateObserver({ contents: c, onChange: (s) => changes.push(s.generation.state), ...t });
  assert.equal(t.pending.length, 0, 'no polling before the page is ready');
  loadPage(c, CONV_A);
  assert.equal(t.pending.length, 1);
  assert.equal(t.pending[0].ms, 5000, 'hidden and idle: slowest cadence');
  o.setVisible(true);
  assert.equal(t.pending[0].ms, 2000);
  await t.fire();
  assert.deepEqual(c.calls[0], [1001, 1]);
  assert.equal(o.getState().generation.state, GEN.IDLE);
  const before = changes.length;
  await t.fire(); await t.fire();                          // identical probes: no new change events
  assert.equal(changes.length, before);
  c.reply = () => sig({ stop: true });
  await t.fire();
  assert.equal(o.getState().generation.state, GEN.RESPONDING);
  assert.equal(t.pending[0].ms, 1000, 'faster while responding');
  assert.equal(o.getStats().polls, 4);
  o.stop();
});

test('observer: a throwing or malformed probe becomes signal-lost, not a state', async () => {
  const c = fakeContents(); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  loadPage(c, CONV_A); await t.fire();
  c.reply = () => sig({ stop: true }); await t.fire();
  assert.equal(o.getState().generation.state, GEN.RESPONDING);
  c.reply = () => new Error('frame detached'); await t.fire();
  assert.equal(o.getState().generation.state, GEN.RESPONDING, 'a probe that did not answer is not an ending');
  assert.equal(o.getState().generation.reason, 'signals-unusable');
  c.reply = () => 'garbage'; await t.fire();
  assert.equal(o.getState().generation.reason, 'signals-unusable');
  assert.equal(o.getState().attention.pending, false);
  assert.equal(o.getStats().signalsLost, 2);
  o.stop();
});

test('observer: in-page navigation updates the identity and drops the previous conversation state', async () => {
  const c = fakeContents(); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  loadPage(c, CONV_A); c.reply = () => sig({ stop: true, draft: true }); await t.fire();
  c.url = CONV_B; c.emit('did-navigate-in-page', {}, CONV_B, true);
  assert.equal(o.getState().identity.id, '22222222-aaaa-bbbb-cccc-000000000002');
  assert.equal(o.getState().generation.state, GEN.UNKNOWN);
  c.emit('did-navigate-in-page', {}, 'https://chatgpt.com/c/ignored-subframe-1', false);   // sub-frames are ignored
  assert.equal(o.getState().identity.id, '22222222-aaaa-bbbb-cccc-000000000002');
  o.stop();
});

test('observer: a probe in flight during a navigation is discarded', async () => {
  const c = fakeContents(); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  loadPage(c, CONV_A);
  let release;
  c.executeJavaScriptInIsolatedWorld = () => new Promise((resolve) => { release = () => resolve(sig({ stop: true, draft: true })); });
  const polling = o.pollNow();
  c.url = CONV_B; c.emit('did-navigate-in-page', {}, CONV_B, true);
  release(); await polling;
  assert.equal(o.getState().generation.state, GEN.UNKNOWN);
  assert.equal(o.getState().draft.state, DRAFT.UNKNOWN);
  o.stop();
});

test('observer: an in-page navigation (new chat receives its URL) does not look like a page load and keeps the response', async () => {
  const c = fakeContents(); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  loadPage(c, 'https://chatgpt.com/'); c.reply = () => sig({ stop: true }); await t.fire();
  assert.equal(o.getState().generation.state, GEN.RESPONDING);
  c.emit('did-start-loading'); c.emit('did-start-navigation', {}, CONV_A, true, true);   // what Electron emits for history.pushState
  c.url = CONV_A; c.emit('did-navigate-in-page', {}, CONV_A, true); c.emit('did-stop-loading');
  assert.equal(o.getState().page, PAGE.READY);
  assert.equal(o.getState().identity.kind, 'conversation');
  assert.equal(o.getState().generation.state, GEN.RESPONDING);
  c.emit('did-start-navigation', {}, 'https://chatgpt.com/c/zzzzzzzz-1', false, false);    // sub-frame navigation: ignored
  assert.equal(o.getState().page, PAGE.READY);
  o.stop();
});

test('observer: reload, failure, crash and background/foreground transitions', async () => {
  const c = fakeContents(); const t = manualTimers(); const attention = [];
  const o = createStateObserver({ contents: c, onChange: (s) => attention.push(s.attention.pending), ...t });
  loadPage(c, CONV_A); o.setVisible(true); c.reply = () => sig({ stop: true }); await t.fire();
  o.setVisible(false);                                        // user switched to the terminal
  c.reply = () => sig({ stop: false, turnActions: true });
  for (let i = 0; i < END_CONFIRMATIONS; i += 1) await t.fire();
  assert.equal(o.getState().generation.state, GEN.COMPLETED);
  assert.equal(o.getState().attention.pending, true);
  o.setVisible(true); o.markViewed();
  assert.equal(o.getState().attention.pending, false);
  c.loading = true; c.emit('did-start-loading'); c.emit('did-start-navigation', {}, CONV_A, false, true);   // reload
  assert.equal(o.getState().page, PAGE.LOADING);
  assert.equal(t.pending.length, 0, 'polling stops while loading');
  c.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', CONV_A, true);
  assert.equal(o.getState().page, PAGE.ERROR);
  c.emit('did-fail-load', {}, -3, 'ERR_ABORTED', CONV_A, true);
  c.emit('did-fail-load', {}, -105, 'x', 'https://x.test', false);
  assert.equal(o.getState().page, PAGE.ERROR);
  loadPage(c, CONV_A);
  assert.equal(o.getState().page, PAGE.READY);
  c.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(o.getState().generation.reason, 'renderer-gone');
  assert.equal(t.pending.length, 0);
  o.stop();
});

test('observer: stop() removes exactly the listeners it added, clears the timer and is idempotent', async () => {
  const c = fakeContents(); const t = manualTimers();
  const base = listenerTotal(c);
  const o = createStateObserver({ contents: c, ...t });
  assert.ok(listenerTotal(c) > base);
  loadPage(c, CONV_A);
  assert.equal(t.pending.length, 1);
  o.stop(); o.stop();
  assert.equal(listenerTotal(c), base, 'no listeners left behind');
  assert.equal(t.pending.length, 0);
  assert.equal(o.getState().page, PAGE.DESTROYED);
  c.emit('did-start-navigation', {}, CONV_B, false, true); c.emit('did-navigate-in-page', {}, CONV_B, true);
  assert.equal(o.getState().page, PAGE.DESTROYED);
  assert.equal(c.calls.length, 0);
});

test('observer: two observers on one contents do not share state, and creating then stopping repeatedly does not leak', () => {
  const c = fakeContents(); const t = manualTimers();
  const base = listenerTotal(c);
  for (let i = 0; i < 20; i += 1) createStateObserver({ contents: c, ...t }).stop();
  assert.equal(listenerTotal(c), base);
});

test('observer attaches to a page that was already loaded and starts from unknown generation', () => {
  const c = fakeContents({ url: CONV_A }); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  assert.equal(o.getState().page, PAGE.READY);
  assert.equal(o.getState().identity.kind, 'conversation');
  assert.equal(o.getState().generation.state, GEN.UNKNOWN);
  o.stop();
});

test('observer attached while the first load is already in flight still becomes ready and starts polling', async () => {
  const c = fakeContents({ loading: true }); const t = manualTimers();
  const o = createStateObserver({ contents: c, ...t });
  assert.equal(o.getState().page, PAGE.LOADING);
  c.url = CONV_A; c.emit('did-navigate', {}, CONV_A);       // the did-start-navigation of this load was missed
  c.loading = false; c.emit('did-stop-loading');
  assert.equal(o.getState().page, PAGE.READY);
  assert.equal(o.getState().identity.kind, 'conversation');
  await t.fire();
  assert.equal(o.getState().generation.state, GEN.IDLE);
  const d = fakeContents({ loading: false }); const u = manualTimers();   // attached before any load at all
  const p = createStateObserver({ contents: d, ...u });
  d.url = CONV_A; d.loading = false; d.emit('did-stop-loading');
  assert.equal(p.getState().page, PAGE.READY);
  o.stop(); p.stop();
});

// ---- diagnostics sink and activation -------------------------------------------------------------------

test('diagnostics log stores transitions without ids or content, and is capped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-diag-'));
  const file = path.join(dir, 'd', 'log.jsonl');
  try {
    const log = createDiagnosticsLog({ file, now: () => 1, maxBytes: 600 });
    const h = harness(); h.load(CONV_A);
    const prev = h.state; h.observe(sig({ stop: true }));
    log.transition(h.state, prev, { type: 'signals' });
    const line = JSON.parse(fs.readFileSync(file, 'utf8').trim());
    assert.equal(line.generation.state, GEN.RESPONDING);
    assert.equal(line.identity.h, shortHash(`c:11111111-aaaa-bbbb-cccc-000000000001`));
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /11111111/, 'the conversation id is hashed');
    for (let i = 0; i < 20; i += 1) log.transition(h.state, prev, { type: 'signals' });
    assert.ok(fs.existsSync(`${file}.1`), 'rotated at the cap');
    assert.ok(fs.statSync(file).size < 2000);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('observation is disabled unless explicitly enabled', () => {
  const c = fakeContents();
  assert.equal(startChatObservation({ contents: c, userDataDir: os.tmpdir(), env: {} }), null);
  assert.equal(startChatObservation({ contents: c, userDataDir: os.tmpdir(), env: { CONTEXTDECK_CHAT_OBSERVER: '0' } }), null);
  assert.equal(listenerTotal(c), 0, 'disabled means no listeners at all');
});

test('the observation modules stay plain Node and never reach for IPC, network or the page API', () => {
  const dir = path.join(__dirname, '..', 'src', 'main', 'chat');
  for (const file of fs.readdirSync(dir)) {
    const source = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.doesNotMatch(source, /require\(['"]electron['"]\)/, file);
    assert.doesNotMatch(source, /ipcMain|ipcRenderer|webRequest|debugger|cookies|session\./, `${file}: no IPC, network, debugger or cookie access`);
    assert.doesNotMatch(source, /MutationObserver|innerText|innerHTML|outerHTML/, `${file}: no content scraping`);
  }
});
