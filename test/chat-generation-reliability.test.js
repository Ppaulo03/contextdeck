'use strict';

// M01-I3B-2R: generation observability reliability. The false positive seen on the real account (a document being written:
// the stop control stays visible, yet the response was reported as ended) is reproduced at three levels: the probe against a
// page whose stop control is outside the composer, the model fed with the signals that page produces, and the hub/navigator
// with the real detector on fake contents. Fixtures are synthetic; no content of any conversation is involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { GEN, EVIDENCE, END_CONFIRMATIONS, UNUSABLE_LIMIT, BUSY_ONLY_LIMIT, createState, reduce } = require('../src/main/chat/state-model');
const { probeSource } = require('../src/main/chat/state-detector');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws } = require('./helpers/bindings-world');

const CONV_A = 'https://chatgpt.com/c/11111111-aaaa-bbbb-cccc-000000000001';
const CONV_B = 'https://chatgpt.com/c/22222222-aaaa-bbbb-cccc-000000000002';
const sig = (over = {}) => ({ composer: true, stop: false, stopWide: false, busy: false, turnActions: false, error: false, interrupted: null, draft: false, ...over });

function harness() {
  let state = createState(); let seq = 0;
  const api = {
    get state() { return state; },
    dispatch(e) { state = reduce(state, e); return state; },
    load(url) { api.dispatch({ type: 'page-loading' }); api.dispatch({ type: 'navigated', url, inPage: false }); api.dispatch({ type: 'page-ready' }); return api; },
    observe(signals, { epoch = state.epoch } = {}) { seq += 1; return api.dispatch({ type: 'signals', epoch, seq, signals }); },
    repeat(signals, n) { for (let i = 0; i < n; i += 1) api.observe(signals); return state; }
  };
  return api;
}
const responding = (view = 'visible') => { const h = harness().load(CONV_A); h.dispatch({ type: 'visibility', visible: view === 'visible' }); h.observe(sig({ stop: true })); return h; };

// ---- the probe: a stop control outside the composer ---------------------------------------------------------------------

const el = (attrs = {}, extra = {}) => ({ hidden: false, getClientRects: () => [1], getAttribute: (n) => (n in attrs ? attrs[n] : null), hasAttribute: (n) => n in attrs, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })), type: '', ...extra });
const WIDE = 'button, [role="button"]';
const BUSY_SEL = '[aria-busy="true"], [data-streaming="true"], [data-is-streaming="true"], [class*="Streaming"], [class*="streaming"]';
function probe(map, options) {
  const document = { body: {}, querySelector: (s) => map[s] || null, querySelectorAll: (s) => (map[s] ? [].concat(map[s]) : []) };
  return vm.runInNewContext(probeSource(options), { document });
}
const composerOnly = { 'textarea[data-octane-input]': el({}, { value: '' }) };

test('a visible control labelled like a stop control OUTSIDE the composer is the stop control (seen live: "Parar" beside a form-less composer)', () => {
  const out = probe({ ...composerOnly, [WIDE]: [el({ 'aria-label': 'Parar' })] });
  assert.equal(out.stop, true);
  assert.equal(out.stopWide, true);
  const live = probe({ [WIDE]: [el({ 'aria-label': 'Parar' })] });          // the live page while answering: no composer form at all
  assert.deepEqual([live.composer, live.stop], [false, true]);
  const byId = probe({ ...composerOnly, [WIDE]: [el({ 'data-testid': 'canvas-stop-button' })] });
  assert.deepEqual([byId.stop, byId.stopWide], [false, true], 'a test-id-only match stays the weaker signal');
});

test('stopWide ignores voice/share/record controls, hidden controls and unrelated buttons; busy needs a visible flagged element', () => {
  for (const label of ['Stop voice recording', 'Parar compartilhamento de tela', 'Stop sharing', 'Parar de gravar']) {
    assert.equal(probe({ ...composerOnly, [WIDE]: [el({ 'aria-label': label })] }).stopWide, false, label);
  }
  assert.equal(probe({ ...composerOnly, [WIDE]: [el({ 'aria-label': 'Parar de gerar' }, { getClientRects: () => [] })] }).stopWide, false, 'not visible');
  assert.equal(probe({ ...composerOnly, [WIDE]: [el({ 'aria-label': 'Copiar' })] }).stopWide, false);
  assert.equal(probe({ ...composerOnly, [WIDE]: [el({ 'data-testid': 'canvas-stop-button' })] }).stopWide, true, 'by test id');
  const busySel = BUSY_SEL;
  assert.equal(probe({ ...composerOnly, [busySel]: [el({ 'aria-busy': 'true' })] }).busy, true);
  assert.equal(probe({ ...composerOnly, [busySel]: [el({ 'aria-busy': 'true' }, { getClientRects: () => [] })] }).busy, false);
  assert.equal(probe(composerOnly).busy, false);
});

test('the wide scan is skipped when the strong signal is present, and every value stays boolean', () => {
  let scanned = false;
  const document = {
    body: {},
    querySelector: (s) => (s === 'textarea[data-octane-input]' ? el({}, { value: 'SECRET' }) : s === '[data-testid="stop-button"]' ? el() : null),
    querySelectorAll: (s) => { if (s === WIDE) scanned = true; return s === '[data-testid="stop-button"]' ? [el()] : []; }
  };
  const out = vm.runInNewContext(probeSource(), { document });
  assert.equal(out.stop, true);
  assert.equal(scanned, false, 'no extra cost while the strong signal holds');
  for (const v of Object.values(out)) assert.ok(v === true || v === false || v === null);
  assert.doesNotMatch(JSON.stringify(out), /SECRET/);
});

test('diagnostic probe tells which wide control matched (label shape only) and how many busy elements exist', () => {
  const out = probe({ ...composerOnly, [WIDE]: [el({ 'aria-label': 'Parar de gerar' })], [BUSY_SEL]: [el(), el()] }, { diagnostic: true });
  assert.deepEqual(JSON.parse(JSON.stringify(out.wide)), { by: 'label', label: 'Parar de gerar', testid: '' });
  assert.equal(out.busyCount, 2);
});

// ---- the model: the reproduced false positive and the evidence rules ---------------------------------------------------

test('REPRODUCTION: a document being written (strong stop absent, stop elsewhere) is never declared over; before 2R one observation ended it', () => {
  const h = responding('hidden');
  const document = sig({ stop: false, stopWide: true });
  for (let i = 0; i < 200; i += 1) h.observe(document);
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  assert.equal(h.state.generation.reason, 'stop-control-elsewhere');
  assert.equal(h.state.generation.evidence, EVIDENCE.INFERRED);
  assert.equal(h.state.attention.pending, false, 'no attention while the response goes on');
  // Same page, stop control gone for good: now (and only now) it ends, unclassified, and the background view asks for review.
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS);
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.generation.reason, 'ended-unclassified');
  assert.equal(h.state.attention.pending, true);
});

test('the composer gone during a document (editor takes over the page) holds the response; it does not end it', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false, composer: false }), 10);
  assert.deepEqual([h.state.generation.state, h.state.generation.reason, h.state.attention.pending], [GEN.RESPONDING, 'signals-unusable', false]);
  h.observe(sig({ stop: true }));
  assert.deepEqual([h.state.generation.evidence, h.state.generation.reason], [EVIDENCE.OBSERVED, 'stop-control'], 'proven again: back to observed responding');
});

test('a control that vanishes for fewer than N observations and returns never ends the response and restarts the count', () => {
  const h = responding('hidden');
  for (let round = 0; round < 5; round += 1) {
    h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
    assert.equal(h.state.generation.state, GEN.RESPONDING);
    assert.equal(h.state.generation.reason, 'end-unconfirmed');
    assert.equal(h.state.attention.pending, false);
    h.observe(sig({ stop: true }));
  }
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  h.observe(sig({ stop: false, stopWide: true }));          // the count restarts when any activity shows up
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  assert.equal(h.state.generation.state, GEN.RESPONDING);
});

test('observations that say nothing (the composer form flickers) neither confirm nor restart the count; a contrary signal does', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  h.repeat(sig({ stop: false, composer: false }), 5);               // seen live: the form is removed and re-created
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.observe(sig({ stop: false }));
  assert.equal(h.state.generation.state, GEN.UNKNOWN, 'the last confirmation completes the count');
  const g = responding('hidden');
  g.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  g.observe(sig({ stop: true }));                                    // a contrary signal restarts it
  g.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  assert.equal(g.state.generation.state, GEN.RESPONDING);
});

test('short response: stop seen once, then a sustained quiet page ends it after exactly N confirmations', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false, turnActions: true }), END_CONFIRMATIONS - 1);
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.observe(sig({ stop: false, turnActions: true }));
  assert.deepEqual(h.state.generation, { state: GEN.COMPLETED, evidence: EVIDENCE.INFERRED, reason: 'stop-gone+turn-actions' });
  assert.equal(h.state.attention.pending, true);
});

test('ended-unclassified is never "completed", with or without a sustained end', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false }), 50);
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.notEqual(h.state.generation.state, GEN.COMPLETED);
});

test('busy alone holds a response for a bounded time only: a stuck flag cannot keep a spinner forever', () => {
  const h = responding('visible');
  h.repeat(sig({ busy: true }), Math.min(BUSY_ONLY_LIMIT, 100));   // bounded: a mutated constant must fail the test, not hang it
  assert.equal(h.state.generation.reason, 'busy-signal');
  h.repeat(sig({ busy: true }), END_CONFIRMATIONS);
  assert.equal(h.state.generation.state, GEN.UNKNOWN, 'after the cap the stuck flag stops sustaining it');
  const idle = harness().load(CONV_A);
  idle.repeat(sig({ busy: true, stopWide: true }), 10);
  assert.equal(idle.state.generation.state, GEN.IDLE, 'weak signals never START a response');
});

test('a response is not claimed forever on silence: UNUSABLE_LIMIT observations without anything usable drop it with no attention', () => {
  const h = responding('hidden');
  h.repeat(sig({ composer: null, stop: null }), Math.min(UNUSABLE_LIMIT, 100) - 1);
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.observe(sig({ composer: null, stop: null }));
  assert.deepEqual([h.state.generation.state, h.state.generation.reason, h.state.attention.pending], [GEN.UNKNOWN, 'uncertain-timeout', false]);
});

test('manual interruption (explicit notice) is classified as interrupted, not completed; attention follows the end rule', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false, interrupted: true, turnActions: true }), END_CONFIRMATIONS);
  assert.equal(h.state.generation.state, GEN.INTERRUPTED);
});

test('navigation during a response: the new conversation starts from nothing, with no attention and no carried streak', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  h.dispatch({ type: 'navigated', url: CONV_B, inPage: true });
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.attention.pending, false);
  h.observe(sig({ stop: false }));
  assert.equal(h.state.generation.state, GEN.IDLE, 'the old streak did not survive the identity change');
  assert.equal(h.state.attention.pending, false);
});

test('a stale probe (requested before a navigation) can neither confirm an end nor start one', () => {
  const h = responding('hidden');
  const epoch = h.state.epoch;
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS - 1);
  h.dispatch({ type: 'navigated', url: CONV_B, inPage: true });
  h.observe(sig({ stop: false }), { epoch });
  assert.equal(h.state.generation.state, GEN.UNKNOWN);
  assert.equal(h.state.attention.pending, false);
});

test('a reload while responding does not raise attention', () => {
  const h = responding('hidden');
  h.dispatch({ type: 'page-loading' });
  h.dispatch({ type: 'page-ready' });
  assert.equal(h.state.attention.pending, false);
});

test('two simultaneous responses are independent: one ending does not end or flag the other', () => {
  const a = responding('hidden'); const b = responding('hidden');
  a.repeat(sig({ stop: false }), END_CONFIRMATIONS);
  b.observe(sig({ stop: false, stopWide: true }));
  assert.equal(a.state.attention.pending, true);
  assert.equal(b.state.generation.state, GEN.RESPONDING);
  assert.equal(b.state.attention.pending, false);
});

test('attention is raised once: further quiet observations or a lost signal after the end add nothing', () => {
  const h = responding('hidden');
  const states = [];
  for (let i = 0; i < 10; i += 1) states.push(h.observe(sig({ stop: false })).attention);
  const raised = states.filter((a, i) => a.pending && (i === 0 || !states[i - 1].pending));
  assert.equal(raised.length, 1);
  h.dispatch({ type: 'signals-lost', epoch: h.state.epoch });
  assert.equal(h.state.attention.pending, true, 'a transient failure does not clear a valid attention');
});

// ---- the hub with the real detector and virtual time --------------------------------------------------------------------

function setup() {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app')] });
  w.select('w1');
  w.A = bindMany(w, [1, 2]);
  w.navigator.setMode('chat');
  w.open = async (b) => {
    const r = w.navigator.selectBinding({ bindingId: b.bindingId, workspaceKey: `contextdeck/${b.workspaceIdentity.workspaceId}` });
    const view = w.fake.views.find((v) => v.id === w.manager.get(r.viewId).id) || w.fake.views.at(-1);
    view.finishLoad(b.url);
    await w.clock.advance(6000);
    return view;
  };
  w.tab = (b) => w.navigator.getState().tabs.find((t) => t.bindingId === b.bindingId);
  w.set = (view, signals) => Object.assign(view.contents.signals, signals);
  return w;
}
const run = async (fn) => { const w = setup(); try { await fn(w); } finally { w.cleanup0(); } };

test('hub: a document written in a background view (stop elsewhere) never raises attention until it really ends', () => run(async (w) => {
  const doc = await w.open(w.A[0]);
  w.set(doc, { stop: true });
  await w.clock.advance(4000);
  await w.open(w.A[1]);                                       // A[0] goes to the background
  w.set(doc, { stop: false, stopWide: true });                // the stop control moved out of the composer
  await w.clock.advance(60000);
  let act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.ended], [true, false, false]);
  assert.equal(act.uncertain, true, 'sustained on thin evidence: shown as such');
  w.set(doc, { stopWide: false });
  await w.clock.advance(1500);
  assert.equal(w.tab(w.A[0]).activity.attention, false, 'not on the first quiet observations');
  await w.clock.advance(6000);
  act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.ended], [false, true, true]);
}));

test('hub: the stop control disappearing for a moment and returning leaves the view responding with no attention', () => run(async (w) => {
  const v = await w.open(w.A[0]);
  w.set(v, { stop: true });
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(v, { stop: false });
  await w.clock.advance(1500);                                // fewer than N polls at the 1 s cadence
  w.set(v, { stop: true });
  await w.clock.advance(5000);
  const act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.uncertain], [true, false, false]);
}));

test('hub: a plain response ending in the background raises one attention event after the sustained end', () => run(async (w) => {
  const events = [];
  w.hub.onAttention?.((e) => events.push(e));
  const v = await w.open(w.A[0]);
  w.set(v, { stop: true });
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(v, { stop: false, turnActions: true });
  await w.clock.advance(15000);
  assert.equal(w.tab(w.A[0]).activity.attention, true);
  assert.ok(events.length <= 1, `attention events: ${events.length}`);
}));

// ---- instrumentation (diagnostic mode only) ------------------------------------------------------------------------------

test('diagnostic log of an uncertain end records signals, streak counters, reason and time between observations; no content', async () => {
  const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
  const { EventEmitter } = require('node:events');
  const { startChatObservation } = require('../src/main/chat');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-2r-'));
  const pending = [];
  const c = new EventEmitter();
  c.url = ''; c.getURL = () => c.url; c.isLoading = () => false; c.isDestroyed = () => false;
  let reply = sig({ stop: true });
  c.executeJavaScriptInIsolatedWorld = async () => ({ ...reply, via: 'candidate', controls: [], form: [] });
  const timers = { setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; pending.push(t); return t; }, clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); }, setRepeat: () => ({ unref() {} }), clearRepeat() {} };
  const o = startChatObservation({ contents: c, userDataDir: dir, env: { CONTEXTDECK_CHAT_OBSERVER: '1' }, viewId: 'v1', ...timers });
  try {
    c.emit('did-start-loading'); c.emit('did-start-navigation', {}, CONV_A, false, true); c.url = CONV_A; c.emit('did-navigate', {}, CONV_A); c.emit('did-stop-loading');
    const fire = async () => { await o.pollNow(); await new Promise((r) => setTimeout(r, 2)); };
    await fire();
    reply = sig({ stop: false });
    await fire(); await fire();
    const lines = fs.readFileSync(path.join(dir, 'diagnostics', 'chat-observer.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const unconfirmed = lines.filter((l) => l.generation && l.generation.reason === 'end-unconfirmed');
    assert.ok(unconfirmed.length >= 2, 'each uncertain step is logged');
    const last = unconfirmed.at(-1);
    assert.equal(last.from.generation, 'responding');
    assert.equal(last.endProbe.confirm, 2);
    assert.equal(last.signals.stop, false);
    assert.equal(typeof last.dtMs, 'number');
    assert.equal(last.attention, false);
    assert.doesNotMatch(JSON.stringify(lines), /11111111-aaaa/, 'conversation id hashed');
  } finally { o.stop(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- the page as seen live (trace of the real account, M01-I3B-2R) --------------------------------------------------------

test('LIVE FORM-LESS PAGE: composer never found, an editable surface is drawn; the response ends after 3 quiet observations, not never', () => {
  const live = (over) => sig({ composer: false, surface: true, stop: false, stopWide: false, busy: false, ...over });
  const h = responding('hidden');
  h.observe(live({ stop: true, stopWide: true }));                 // "Parar" outside any form
  h.repeat(live({ busy: true }), 4);                               // AdaptiveStreaming-... class present
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  h.repeat(live(), END_CONFIRMATIONS - 1);
  assert.equal(h.state.generation.state, GEN.RESPONDING, 'not on the first quiet observations');
  assert.equal(h.state.attention.pending, false);
  h.observe(live());
  assert.deepEqual([h.state.generation.state, h.state.generation.reason, h.state.attention.pending], [GEN.UNKNOWN, 'ended-unclassified', true]);
});

test('a page with nothing drawn (no composer, no editable surface) never confirms an ending', () => {
  const h = responding('hidden');
  h.repeat(sig({ composer: false, surface: false, stop: false }), UNUSABLE_LIMIT - 1);
  assert.equal(h.state.generation.state, GEN.RESPONDING);
  assert.equal(h.state.attention.pending, false);
});

test('probe: surface is any visible editable element; a streaming class token counts as busy', () => {
  const EDIT = 'textarea, [contenteditable="true"], [contenteditable=""], [role="textbox"]';
  assert.equal(probe({ [EDIT]: [el()] }).surface, true);
  assert.equal(probe({ [EDIT]: [el({}, { getClientRects: () => [] })] }).surface, false);
  assert.equal(probe({}).surface, false);
  assert.equal(probe({ [BUSY_SEL]: [el({ class: 'AdaptiveStreaming-abc' })] }).busy, true);
});

test('LIVE: an established ending survives the composer being re-drawn (form missing / undeterminable) until a new response or a new identity', () => {
  const h = responding('hidden');
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS);
  assert.equal(h.state.generation.reason, 'ended-unclassified');
  h.repeat(sig({ composer: false, surface: true, stop: false }), 5);
  h.observe(sig({ composer: null, stop: null }));
  h.dispatch({ type: 'signals-lost', epoch: h.state.epoch });
  assert.equal(h.state.generation.reason, 'ended-unclassified', 'not overwritten by composer-missing / incomplete / lost');
  assert.equal(h.state.attention.pending, true);
  h.observe(sig({ stop: true }));
  assert.equal(h.state.generation.state, GEN.RESPONDING, 'a new response replaces it');
  h.repeat(sig({ stop: false }), END_CONFIRMATIONS);
  h.dispatch({ type: 'navigated', url: CONV_B, inPage: true });
  assert.equal(h.state.generation.reason, 'identity-changed');
});
