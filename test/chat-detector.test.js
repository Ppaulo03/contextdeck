'use strict';

// M01-I3P follow-up: the first live run (logged in) found no composer with the selectors learned on the
// logged-out page. These tests pin the structural lookup, the stop detection from the composer's form, the
// sanitized structure snapshot and the diagnostics orchestration.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { probeSource, structureSource, sanitizeProbe, sanitizeStructure } = require('../src/main/chat/state-detector');
const { createStateObserver } = require('../src/main/chat/state-observer');
const { startChatObservation } = require('../src/main/chat');

const CONV = 'https://chatgpt.com/c/11111111-aaaa-bbbb-cccc-000000000001';

function element(attrs = {}, extra = {}) {
  return {
    hidden: false,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    hasAttribute: (n) => n in attrs,
    getClientRects: () => [1],
    children: [],
    type: attrs.type || '',
    ...extra
  };
}
const button = (attrs = {}) => element({ type: 'button', ...attrs });
const formOf = (buttons, hasSubmit = true) => ({ querySelector: () => (hasSubmit ? buttons[0] : null), querySelectorAll: (s) => (s === 'button' ? buttons : []), attributes: [] });
const editableIn = (form, extra = {}) => element({ contenteditable: 'true', id: 'x' }, { closest: (s) => (s === 'form' ? form : null), value: undefined, textContent: '', ...extra });
function dom({ editables = [], lists = {} } = {}) {
  return {
    body: {},
    querySelector: (s) => (lists[s] && lists[s][0]) || null,
    querySelectorAll: (s) => (s.startsWith('textarea, [contenteditable') ? editables : lists[s] || [])
  };
}
const probe = (document, options) => vm.runInNewContext(probeSource(options), { document });

test('unknown selectors: the composer is the editable element of the form that holds a submit control', () => {
  const form = formOf([button({ type: 'submit', 'aria-label': 'Enviar mensagem' })]);
  const out = probe(dom({ editables: [editableIn(form, { textContent: 'a draft' })] }), { diagnostic: true });
  assert.equal(out.composer, true);
  assert.equal(out.via, 'structural');
  assert.equal(out.draft, true, 'draft read from a contenteditable');
  assert.equal(out.stop, false);
});

test('the LAST editable of a form with submit wins: the edit box of an earlier message is not the composer', () => {
  const editBox = editableIn(formOf([button({ type: 'submit' })]), { textContent: 'message being edited' });
  const composer = editableIn(formOf([button({ type: 'submit' })]), { textContent: '' });
  assert.equal(probe(dom({ editables: [editBox, composer] })).draft, false);
});

test('lone-editable and shadow tiers; ambiguity is never guessed; nothing editable means no composer', () => {
  assert.equal(probe(dom({ editables: [editableIn(null)] }), { diagnostic: true }).via, 'lone');
  const two = [editableIn(null), editableIn(null)];
  assert.equal(probe(dom({ editables: two }), { diagnostic: true }).composer, false);
  const inShadow = editableIn(null, { textContent: 'x' });
  const shadow = probe(dom({ editables: two, lists: { '*': [{}, { shadowRoot: { querySelectorAll: () => [inShadow] } }] } }), { diagnostic: true });
  assert.equal(shadow.via, 'shadow');
  assert.equal(shadow.draft, true);
  assert.equal(probe(dom(), { diagnostic: true }).composer, false);
  assert.equal(probe({ body: null, querySelector: () => null, querySelectorAll: () => [] }).composer, null);
});

test('diagnostic probe logs the composer form attributes (state attributes live there), values only when short', () => {
  const form = Object.assign(formOf([button({ type: 'submit' })]), { attributes: [{ name: 'data-announcement-stopped', value: 'Parado' }, { name: 'class', value: 'x' }, { name: 'data-long', value: 'y'.repeat(60) }, { name: 'data-state', value: 'idle' }] });
  const out = probe(dom({ editables: [editableIn(form)] }), { diagnostic: true });
  assert.deepEqual(JSON.parse(JSON.stringify(out.form)), ['data-announcement-stopped=Parado', 'data-long', 'data-state=idle']);
  assert.equal(probe(dom({ editables: [editableIn(form)] })).form, undefined, 'plain probe adds nothing');
});

test('known selector still wins and is reported as such', () => {
  const out = probe(dom({ lists: { 'textarea[data-octane-input]': [element({}, { value: 'x' })] } }), { diagnostic: true });
  assert.equal(out.via, 'candidate');
  assert.equal(out.draft, true);
});

test('stop is read from ANY button of the composer form (label, test id, state attribute), not only from known selectors', () => {
  const mk = (attrs) => dom({ editables: [editableIn(formOf([button({ type: 'submit', ...attrs })]))] });
  assert.equal(probe(mk({ 'aria-label': 'Interromper geração' })).stop, true);
  assert.equal(probe(mk({ 'data-testid': 'composer-stop-thing' })).stop, true);
  assert.equal(probe(mk({ 'data-state': 'streaming' })).stop, true);
  assert.equal(probe(mk({ 'aria-label': 'Enviar mensagem', 'data-send-label': 'Enviar mensagem', 'data-stop-label': 'Interromper geração' })).stop, false, 'both captions live on the button at all times');
  assert.equal(probe(dom({ editables: [editableIn(formOf([button({ 'aria-label': 'Parar de gravar' }), button({ type: 'submit' })]))] })).stop, true);
});

test('structure snapshot: counts and control attributes only; neither the draft nor an attachment name is recorded', () => {
  const attachRemove = button({ 'aria-label': 'Remover arquivo contrato-secreto.pdf', class: 'c' });
  const send = button({ type: 'submit', 'aria-label': 'Enviar mensagem', 'data-testid': 'send-button' });
  const form = formOf([attachRemove, send]);
  const composer = editableIn(form, { textContent: 'MY PRIVATE DRAFT' });
  const raw = vm.runInNewContext(structureSource(), { document: dom({ editables: [composer], lists: { form: [form], '[data-testid]': [element({ 'data-testid': 'send-button' })] } }) });
  const clean = sanitizeStructure(JSON.parse(JSON.stringify(raw)));
  assert.doesNotMatch(JSON.stringify(clean), /PRIVATE|secreto/);
  assert.equal(clean.composer.found, true);
  assert.equal(clean.composer.via, 'structural');
  assert.equal(clean.form.buttons.length, 2);
  assert.equal(clean.form.buttons[0].label, '', 'unnamed buttons keep no label');
  assert.equal(clean.form.buttons[1].label, 'Enviar mensagem');
  assert.deepEqual(clean.testids, ['send-button']);
});

test('sanitizers rebuild results from scratch: oversize, wrong types and extra fields are dropped', () => {
  const huge = 'x'.repeat(5000);
  const clean = sanitizeStructure({ readyState: huge, forms: 'many', editable: [{ tag: huge, attrs: [huge, 5, null], visible: 'yes', text: 'leak' }], composer: { found: 1, via: 'telepathy', tag: 'DIV', attrs: [] }, form: { buttons: [{ label: huge, type: huge, extra: 'leak' }], attrs: [] }, testids: [huge], leak: 'leak', known: { composer: [1, 'a'] } });
  const text = JSON.stringify(clean);
  assert.ok(text.length < 1500, 'bounded');
  assert.doesNotMatch(text, /leak/);
  assert.equal(clean.forms, 0);
  assert.equal(clean.composer.via, null);
  assert.equal(clean.editable[0].visible, false);
  assert.equal(sanitizeStructure(null), null);
  assert.deepEqual(sanitizeProbe({ via: 'candidate', controls: [{ label: 'a', attrs: ['b'], leak: 1 }], form: ['data-x=1', 5], secret: 'x' }), { via: 'candidate', controls: [{ type: '', testid: '', label: 'a', attrs: ['b'] }], form: ['data-x=1', ''], wide: null, busyCount: 0 });
  assert.deepEqual(sanitizeProbe({ via: 'other' }), { via: null, controls: [], form: [], wide: null, busyCount: 0 });
  assert.deepEqual(sanitizeProbe({ wide: { by: 'x', label: 'y'.repeat(500), testid: 5, leak: 1 }, busyCount: 1e9 }).wide, { by: null, label: 'y'.repeat(40), testid: '' });
  assert.equal(sanitizeProbe({ busyCount: 1e9 }).busyCount, 1e6);
});

// ---- observer instrumentation and diagnostics orchestration ----------------------------------------------

function fakeContents({ replies } = {}) {
  const c = new EventEmitter();
  c.url = ''; c.loading = false; c.calls = []; c.replies = replies || {};
  c.getURL = () => c.url; c.isLoading = () => c.loading; c.isDestroyed = () => false;
  c.executeJavaScriptInIsolatedWorld = async (_world, scripts) => {
    const code = scripts[0].code;
    c.calls.push(code.includes('shadowHosts') ? 'structure' : 'probe');
    return code.includes('shadowHosts') ? c.replies.structure : c.replies.probe;
  };
  return c;
}
const timers = () => {
  const pending = [];
  return { pending, setTimer: (fn, ms) => { const t = { fn, ms, unref() {} }; pending.push(t); return t; }, clearTimer: (t) => { const i = pending.indexOf(t); if (i >= 0) pending.splice(i, 1); } };
};
const load = (c, url) => { c.loading = true; c.emit('did-start-navigation', {}, url, false, true); c.url = url; c.emit('did-navigate', {}, url); c.loading = false; c.emit('did-stop-loading'); };
const readLog = (dir) => fs.readFileSync(path.join(dir, 'diagnostics', 'chat-observer.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('observer counts results the model discards (stale epoch) so a silent loss is visible', async () => {
  const c = fakeContents(); const t = timers();
  const o = createStateObserver({ contents: c, ...t });
  load(c, CONV);
  let release;
  c.executeJavaScriptInIsolatedWorld = () => new Promise((r) => { release = () => r({ composer: true, stop: false, turnActions: false, error: false, interrupted: null, draft: false }); });
  const pending = o.pollNow();
  c.url = 'https://chatgpt.com/c/22222222-aaaa-bbbb-cccc-000000000002'; c.emit('did-navigate-in-page', {}, c.url, true);
  release(); await pending;
  assert.equal(o.getStats().dropped.stale, 1);
  o.stop();
});

test('snapshotStructure returns only sanitized data and nothing when not ready or on failure', async () => {
  const c = fakeContents({ replies: { structure: { forms: 2, composer: { found: false }, secret: 'leak', testids: ['a'] }, probe: { composer: false } } });
  const t = timers();
  const o = createStateObserver({ contents: c, ...t });
  assert.equal(await o.snapshotStructure(), null, 'page not ready yet');
  load(c, CONV);
  const s = await o.snapshotStructure();
  assert.equal(s.forms, 2);
  assert.doesNotMatch(JSON.stringify(s), /leak/);
  c.executeJavaScriptInIsolatedWorld = async () => { throw new Error('detached'); };
  assert.equal(await o.snapshotStructure(), null);
  o.stop();
  assert.equal(await o.snapshotStructure(), null, 'stopped observers do nothing');
});

test('diagnostic orchestration: snapshots while the composer is missing, summaries, bounded, and full cleanup on stop', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-diag2-'));
  const c = fakeContents({ replies: { structure: { forms: 1, composer: { found: false } }, probe: { composer: false, stop: false, turnActions: false, error: false, interrupted: null, draft: null, via: null, controls: [] } } });
  const t = timers(); const repeats = []; const cleared = [];
  try {
    const o = startChatObservation({
      contents: c, userDataDir: dir, env: { CONTEXTDECK_CHAT_OBSERVER: '1' },
      setTimer: t.setTimer, clearTimer: t.clearTimer,
      setRepeat: (fn, ms) => { const r = { fn, ms, unref() {} }; repeats.push(r); return r; }, clearRepeat: (r) => cleared.push(r)
    });
    load(c, CONV);
    const snapshotTimers = t.pending.filter((x) => x.ms === 3000 || x.ms === 20000);
    assert.equal(snapshotTimers.length, 2, 'two looks after a load');
    await o.pollNow();
    for (const x of snapshotTimers) { t.pending.splice(t.pending.indexOf(x), 1); await x.fn(); }
    repeats[0].fn();
    const lines = readLog(dir);
    assert.equal(lines.filter((l) => l.structure).length, 2);
    const summary = lines.find((l) => l.summary).summary;
    assert.equal(summary.counters.composer.f, 1, 'one probe saw no composer');
    assert.ok('stale' in summary.dropped && 'order' in summary.dropped);
    assert.doesNotMatch(JSON.stringify(lines), /MY PRIVATE/);
    // a composer that is found cancels further snapshots
    c.replies.probe = { ...c.replies.probe, composer: true, via: 'structural' };
    await o.pollNow();
    const before = lines.length;
    c.url = 'https://chatgpt.com/c/22222222-aaaa-bbbb-cccc-000000000002'; c.emit('did-navigate-in-page', {}, c.url, true);   // a new search starts
    o.stop();
    assert.equal(cleared.length, 1, 'summary interval cleared');
    assert.equal(t.pending.length, 0, 'no timers left');
    assert.ok(readLog(dir).length >= before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rapid visibility toggles do not keep postponing the pending poll (no starvation)', () => {
  const c = fakeContents(); const t = timers();
  const o = createStateObserver({ contents: c, ...t });
  load(c, CONV);
  o.setVisible(true);
  const armed = t.pending[0];
  assert.equal(armed.ms, 2000);
  for (let i = 0; i < 10; i += 1) { o.setVisible(false); o.setVisible(true); }
  assert.equal(t.pending.length, 1);
  assert.equal(t.pending[0], armed, 'the poll that was already due is kept');
  o.stop();
});
