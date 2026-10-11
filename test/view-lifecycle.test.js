'use strict';

// M01-I3C-1: view lifecycle. The real manager, navigator, observation hub, I3P observer and bindings service on fake pages and virtual time.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws, chatUrl, projectUrl } = require('./helpers/bindings-world');
const { blockers, REASON } = require('../src/main/chat-views/lifecycle');

const WK = (id) => `contextdeck/${id}`;
const RESPONDING = { stop: true };
const IDLE = { stop: false, turnActions: false };

function setup(opts = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app'), ws('w3', 'empty')], ...opts });
  w.select('w1');
  w.A = bindMany(w, [1, 2, 3], opts.extra || {});
  w.select('w2');
  w.B = bindMany(w, [4, 5]);
  w.select('w1');
  w.navigator.setMode('chat');
  w.pick = (b, extra = {}) => w.navigator.selectBinding({ bindingId: b.bindingId, workspaceKey: WK(b.workspaceIdentity.workspaceId), ...extra });
  w.open = async (b) => {
    const r = w.pick(b);
    const view = w.fake.views.find((v) => v.id === r.viewId);
    view.finishLoad(b.url);
    await w.clock.advance(6000);
    return view;
  };
  w.tab = (b) => w.navigator.getState().tabs.find((t) => t.bindingId === b.bindingId);
  w.set = (view, signals) => Object.assign(view.contents.signals, signals);
  w.viewOf = (b) => w.manager.findByKey(b.conversationKey) || w.manager.list().find((v) => v.expectedKey === b.conversationKey) || null;
  // A conversation opened and then left in the background: observed, idle, no draft.
  w.background = async (b) => { const v = await w.open(b); await w.open(w.A.find((x) => x !== b && w.viewOf(x) === null)); return v; };
  w.suspend = (b) => w.lifecycle.suspend({ viewId: w.viewOf(b).id });
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };
const reasonsOf = (w, b) => w.lifecycle.describe(w.viewOf(b).id).reasons;

// ---- inventory ------------------------------------------------------------------------------------------------------------------------

test('the inventory lists every loaded view with its state and kind, and counts suspended conversations separately', () => run(async (w) => {
  assert.deepEqual(w.lifecycle.inventory(), [], 'nothing is loaded: nothing is reported (and nothing is idle)');
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const rows = w.lifecycle.inventory();
  assert.equal(rows.length, 2);
  const r1 = rows.find((r) => r.viewId === a1.id);
  assert.deepEqual([r1.state, r1.kind, r1.selected, r1.hasBinding, r1.stableUrl, r1.observed, r1.responding, r1.draft, r1.attention, r1.eligible], ['background', 'binding', false, true, true, true, false, 'empty', false, true]);
  assert.deepEqual([rows.find((r) => r.selected).state, rows.find((r) => r.selected).eligible], ['active', false]);
  assert.deepEqual(w.lifecycle.summary(), { created: 2, selected: 1, hidden: 1, residual: 0, observed: 2, suspended: 0, eligible: 1, unrecoverable: 0 });
  assert.equal((await w.suspend(w.A[0])).ok, true);
  assert.deepEqual(w.lifecycle.summary(), { created: 1, selected: 1, hidden: 0, residual: 0, observed: 1, suspended: 1, eligible: 0, unrecoverable: 0 });
  assert.equal(w.lifecycle.inventory().find((r) => r.state === 'suspended').bindingId, w.A[0].bindingId);
}));

test('a view that is loading is created (first load) or restoring (after a suspension)', () => run(async (w) => {
  const v = await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.pick(w.A[2]);
  assert.equal(w.lifecycle.describe(w.viewOf(w.A[2]).id).state, 'created');
  w.fake.views.at(-1).finishLoad();
  await w.clock.advance(6000);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  w.pick(w.A[0]);
  assert.equal(w.lifecycle.describe(w.viewOf(w.A[0]).id).state, 'restoring');
  assert.ok(v.isDestroyed());
}));

// ---- eligibility: positive -------------------------------------------------------------------------------------------------------------

test('an idle, observed, draft-free background conversation is eligible', () => run(async (w) => {
  await w.background(w.A[0]);
  assert.deepEqual(w.lifecycle.describe(w.viewOf(w.A[0]).id), { state: 'background', kind: 'binding', eligible: true, reasons: [] });
  assert.equal(w.tab(w.A[0]).lifecycle.eligible, true);
}));

test('ended-unclassified is not enough by itself, but with every other condition met it is allowed', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING); await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE); await w.clock.advance(6000);
  assert.equal(w.hub.summaryOf(w.viewOf(w.A[0]).id).generation, 'ended-unclassified');
  assert.deepEqual(reasonsOf(w, w.A[0]), [REASON.ATTENTION], 'the response ended unseen: attention blocks, not the generation');
  w.pick(w.A[0]);                                                      // a visit acknowledges it
  await w.open(w.A[1]);
  assert.deepEqual(reasonsOf(w, w.A[0]), []);
}));

// ---- eligibility: negative (each rule) ------------------------------------------------------------------------------------------------

test('the selected view is never eligible, not even while the Terminal tab is showing', () => run(async (w) => {
  await w.open(w.A[0]);
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.SELECTED));
  w.navigator.setMode('terminal');
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.SELECTED), 'it is what comes back on screen');
  const r = await w.suspend(w.A[0]);
  assert.deepEqual([r.ok, r.error.code, r.error.reasons.includes(REASON.SELECTED)], [false, 'not_eligible', true]);
  assert.equal(w.viewOf(w.A[0]).page, 'ready');
}));

test('a response in progress blocks, and so does one that only started since the last scheduled reading (fresh probe)', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING); await w.clock.advance(4000);
  await w.open(w.A[1]);
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.RESPONDING));
  // Started between the last poll and the click:
  const b = await w.open(w.A[2]); await w.open(w.A[1]);
  assert.deepEqual(reasonsOf(w, w.A[2]), [], 'the cached reading says idle');
  w.set(b, RESPONDING);
  const r = await w.suspend(w.A[2]);
  assert.equal(r.ok, false);
  assert.ok(r.error.reasons.includes(REASON.RESPONDING) || r.error.reasons.includes(REASON.UNKNOWN), JSON.stringify(r.error.reasons));
  assert.equal(w.viewOf(w.A[2]).page, 'ready', 'still there');
}));

test('a draft blocks; a draft that appears between the last reading and the click is caught by the fresh reading', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.deepEqual(reasonsOf(w, w.A[0]), []);
  w.set(a1, { draft: true });                                        // typed since the last poll
  const r = await w.suspend(w.A[0]);
  assert.deepEqual([r.ok, r.error.reasons], [false, [REASON.DRAFT]]);
  assert.equal(w.manager.isSuspended(w.A[0].conversationKey), false);
  assert.equal(a1.isDestroyed(), false);
  assert.ok(w.lifecycleEvents.some((e) => e.type === 'refused'));
}));

test('an unreadable draft (composer not found) blocks: unknown is not empty', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.set(a1, { composer: false, draft: null });
  const r = await w.suspend(w.A[0]);
  assert.equal(r.ok, false);
  assert.ok(r.error.reasons.some((x) => [REASON.DRAFT_UNKNOWN, REASON.UNKNOWN].includes(x)), JSON.stringify(r.error.reasons));
}));

test('a probe that errors or never answers blocks (a timeout is not evidence of inactivity)', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  a1.contents.probeError = new Error('renderer busy');
  let r = await w.suspend(w.A[0]);
  assert.equal(r.ok, false, 'error');
  a1.contents.probeError = null;
  a1.contents.hang = true;
  const pending = w.suspend(w.A[0]);
  await w.clock.advance(6000);                                       // the observer's own probe timeout
  r = await pending;
  assert.equal(r.ok, false, 'hang');
  assert.equal(a1.isDestroyed(), false);
}));

test('pending attention blocks and a lifecycle action never clears it', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING); await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE); await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]).activity.attention, true);
  const r = await w.suspend(w.A[0]);
  assert.deepEqual([r.ok, r.error.reasons], [false, [REASON.ATTENTION]]);
  assert.equal(w.tab(w.A[0]).activity.attention, true, 'still pending after the refused request');
}));

test('a view that is navigating, in an error state, or on a different conversation than it stands for is not eligible', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  a1.navigate(w.B[0].url);                                           // the user opened another conversation INSIDE ChatGPT
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.IDENTITY));
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.CONFLICT) || w.navigator.getState().tabs[0].relation === 'diverged');
  a1.navigate(w.A[0].url);                                           // and back
  await w.clock.advance(6000);
  assert.deepEqual(reasonsOf(w, w.A[0]), []);
  a1.contents.emit('did-start-navigation', {}, 'https://chatgpt.com/', false, true);
  a1.emit('navigation-started');
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.NAVIGATING));
}));

test('a conversation whose identity was never confirmed on its page (redirected away) is not eligible', () => run(async (w) => {
  w.pick(w.A[0]);
  const v = w.fake.views[0];
  v.finishLoad('https://chatgpt.com/');                              // unavailable conversation: the page ends on the home
  await w.clock.advance(6000);
  await w.open(w.A[1]);
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.IDENTITY));
}));

test('initial page, temporary pages and pages with a pending decision or creation are not eligible', () => run(async (w) => {
  const initial = w.manager.create({ url: w.HOME, scope: null, pristine: true });
  assert.deepEqual(w.lifecycle.describe(initial).reasons.includes(REASON.INITIAL), true);
  const created = w.navigator.newConversation({ workspaceKey: WK('w1') });
  assert.equal(created.ok, true);
  const t = created.viewId;
  const d = w.lifecycle.describe(t);
  assert.ok(d.reasons.includes(REASON.TEMPORARY) && d.reasons.includes(REASON.CREATING), JSON.stringify(d));
  const r = await w.lifecycle.suspend({ viewId: t });
  assert.equal(r.ok, false);
  // A bound page with an unresolved question for the user.
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.navigator.setNoteProvider((id) => (id === w.viewOf(w.A[0]).id ? { kind: 'pending', code: 'x', text: 'nao vinculada' } : null));
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.DECISION));
  assert.equal(a1.isDestroyed(), false);
}));

test('a conversation that is a conflict, or shown by two pages, is not eligible', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const dup = w.manager.create({ url: w.A[0].url, scope: null });
  w.fake.views.at(-1).finishLoad(w.A[0].url);
  await w.clock.advance(6000);
  assert.deepEqual(w.manager.duplicates().length, 1);
  assert.ok(w.lifecycle.describe(dup).reasons.includes(REASON.DUPLICATE));
  assert.ok(reasonsOf(w, w.A[0]).includes(REASON.DUPLICATE));
  assert.equal((await w.lifecycle.suspend({ viewId: dup })).ok, false);
  assert.equal(a1.isDestroyed(), false);
}));

test('a workspace switch in progress blocks the suspension, including one that starts while the fresh reading is awaited', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const pending = w.suspend(w.A[0]);
  w.sel.pending = { workspaceId: 'w2' };                              // the user starts a switch meanwhile
  const r = await pending;
  assert.deepEqual([r.ok, r.error.reasons.includes(REASON.SWITCHING)], [false, true]);
  assert.equal(a1.isDestroyed(), false);
  w.sel.pending = null;
}));

test('blockers() is pure and closed: no facts, no observation, an unreadable generation each block', () => {
  assert.deepEqual(blockers(null), [REASON.NOT_READY]);
  const base = { kind: 'binding', selected: false, page: 'ready', identity: { state: 'durable', key: 'c:x' }, expectedKey: 'c:x', reached: true, relation: 'match', recoveryUrl: 'https://chatgpt.com/c/11111111-1111-4111-8111-111111111111', binding: { status: 'linked' }, observed: false, summary: null };
  assert.ok(blockers(base).includes(REASON.UNOBSERVED));
  assert.ok(blockers({ ...base, observed: true, summary: { identityOk: true, phase: 'ready', observedAt: 1, stale: false, uncertain: false, generation: 'unknown', evidence: 'unknown', draft: 'empty', attention: 'none' } }).includes(REASON.UNKNOWN));
});

// ---- suspension ----------------------------------------------------------------------------------------------------------------------

test('suspending releases the page, stops its observer and timers, and keeps the binding, the preference and the tab', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const before = JSON.stringify(w.bindings.all());
  const lastBefore = JSON.stringify(w.last);
  const timersBefore = w.clock.timers.length;
  const polls = a1.contents.probes;
  const r = await w.suspend(w.A[0]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.kind, r.bindingId, typeof r.timings.releaseMs], ['binding', w.A[0].bindingId, 'number']);
  assert.equal(a1.isDestroyed(), true, 'page released');
  assert.equal(w.manager.list().length, 1);
  assert.equal(w.hub.isObserved(a1.id), false);
  assert.equal(w.hub.stats().observers, 1);
  assert.ok(w.clock.timers.length < timersBefore, 'the observer timer is gone');
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-stop-loading', 'did-start-navigation', 'did-fail-load', 'render-process-gone', 'destroyed']) assert.equal(a1.contents.listenerCount(ev), 0, `no listener left for ${ev}`);
  await w.clock.advance(60000);
  assert.equal(a1.contents.probes, polls + 1, 'only the one fresh reading of the request; nothing probes it afterwards');
  assert.equal(JSON.stringify(w.bindings.all()), before, 'bindings untouched');
  assert.equal(JSON.stringify(w.last), lastBefore, 'preferences untouched');
  const tab = w.tab(w.A[0]);
  assert.deepEqual([tab.suspended, tab.loaded, tab.activity], [true, false, null]);
  assert.equal(w.selectCalls.length, 0, 'no Herdr command');
}));

test('a suspended conversation is not shown as idle, produces no notice, and clears nothing pending elsewhere', () => run(async (w) => {
  const events = [];
  const offA = w.hub.onAttention((e) => events.push(e));
  const a1 = await w.open(w.A[0]);
  const a2 = await w.open(w.A[1]);
  w.set(a2, RESPONDING); await w.clock.advance(4000);
  await w.open(w.A[2]);
  w.set(a2, IDLE); await w.clock.advance(6000);                       // A2 ended unseen: pending
  events.length = 0;
  assert.equal(w.tab(w.A[1]).activity.attention, true);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  assert.equal(events.length, 0, 'suspending raised no notice');
  assert.equal(w.tab(w.A[1]).activity.attention, true, 'another conversation keeps its pending attention');
  assert.equal(w.tab(w.A[0]).activity, null, 'not observed, so not claimed idle');
  const g = w.navigator.getGlobalActivity();
  assert.deepEqual([g.totals.suspended, g.totals.loaded, g.totals.attention], [1, 2, 1]);
  offA();
  assert.ok(a1.isDestroyed());
}));

test('a stale event of the released page is dropped: no state change, no observer, no probe', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  let changes = 0;
  const off = w.manager.onChange(() => { changes += 1; });
  const probes = a1.contents.probes;
  for (const [k, p] of [['navigated', { url: w.B[0].url }], ['loaded', {}], ['load-failed', { error: {} }], ['process-gone', {}], ['navigation-started', {}], ['destroyed', {}]]) a1.emit(k, p);
  a1.contents.emit('did-navigate', {}, w.B[0].url);
  await w.clock.advance(60000);
  assert.equal(changes, 0);
  assert.equal(a1.contents.probes, probes);
  assert.equal(w.manager.list().length, 1);
  assert.equal(w.manager.isSuspended(w.A[0].conversationKey), true, 'still suspended');
  off();
}));

test('two simultaneous requests for the same view: one suspends, the other is told it is busy', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  const id = w.viewOf(w.A[0]).id;
  const [x, y] = await Promise.all([w.lifecycle.suspend({ viewId: id }), w.lifecycle.suspend({ viewId: id })]);
  assert.deepEqual([x.ok, y.ok, y.error.code], [true, false, 'busy']);
  assert.equal(w.manager.suspendedList().length, 1);
  assert.equal(w.lifecycle.isBusy(id), false, 'the lock is released');
}));

test('selecting the conversation while the suspension awaits its reading wins: nothing is released', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const pending = w.suspend(w.A[0]);
  w.pick(w.A[0]);                                                     // the user clicks the tab meanwhile
  const r = await pending;
  assert.deepEqual([r.ok, r.error.reasons.includes(REASON.SELECTED)], [false, true]);
  assert.equal(a1.isDestroyed(), false);
  assert.equal(w.manager.getVisibleId(), a1.id);
}));

test('the application closing during a suspension: no error, nothing recorded', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  const pending = w.suspend(w.A[0]);
  w.hub.stop();
  w.manager.destroyAll();
  const r = await pending;
  assert.deepEqual([r.ok, r.error.code], [false, 'shutting_down']);
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal((await w.lifecycle.suspend({ viewId: 'v1' })).error.code, 'shutting_down');
}));

test('requests for something that is not loaded are refused', () => run(async (w) => {
  assert.equal((await w.lifecycle.suspend({ viewId: 'v99' })).error.code, 'view_not_found');
  assert.equal((await w.lifecycle.suspend({})).error.code, 'view_not_found');
  assert.equal((await w.lifecycle.suspend()).error.code, 'view_not_found');
}));

// ---- restoration ---------------------------------------------------------------------------------------------------------------------

test('selecting a suspended conversation restores it: same session, its stored address, one view, binding untouched, no Herdr command', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const before = JSON.stringify(w.bindings.all());
  assert.equal((await w.suspend(w.A[0])).ok, true);
  const created = w.fake.views.length;
  const r = w.pick(w.A[0]);
  assert.equal(r.ok, true);
  assert.equal(w.fake.views.length, created + 1);
  const back = w.fake.views.at(-1);
  assert.deepEqual(back.loads, [w.A[0].url], 'navigates to the stored address of the binding');
  assert.notEqual(back.id, a1.id);
  assert.deepEqual([w.tab(w.A[0]).suspended, w.tab(w.A[0]).loading, w.tab(w.A[0]).active], [false, true, true], 'loading state is visible');
  back.finishLoad(w.A[0].url);
  await w.clock.advance(6000);
  assert.deepEqual([w.tab(w.A[0]).loading, w.tab(w.A[0]).relation], [false, 'match']);
  assert.equal(w.manager.duplicates().length, 0);
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal(JSON.stringify(w.bindings.all()), before);
  assert.equal(w.selectCalls.length, 0);
  assert.equal(w.hub.isObserved(back.id), true, 'observation resumes once the identity is confirmed');
  const snap = w.manager.get(back.id);
  assert.deepEqual([snap.restored, typeof snap.restoreMs], [true, 'number']);
  assert.ok(w.lifecycleEvents.some((e) => e.type === 'restored' && e.viewId === back.id));
}));

test('restoring twice (double click, repeated request) never makes a second canonical view', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  const n = w.fake.views.length;
  w.pick(w.A[0]); w.pick(w.A[0]); w.pick(w.A[0]);
  assert.equal(w.fake.views.length, n + 1);
  w.navigator.reconcile();
  w.hub.sync();
  assert.equal(w.manager.list().filter((v) => v.expectedKey === w.A[0].conversationKey).length, 1);
}));

test('an internal navigation while restoring is an ordinary navigation: no extra view, no association, the binding stays', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  w.pick(w.A[0]);
  const back = w.fake.views.at(-1);
  const count = w.fake.views.length;
  back.navigate(w.A[2].url);                                         // ChatGPT sends the page elsewhere before it finished loading
  back.finishLoad(w.A[2].url);
  await w.clock.advance(6000);
  assert.equal(w.fake.views.length, count);
  assert.equal(w.bindings.all().length, 5);
  assert.equal(w.manager.get(back.id).relation, 'diverged');
}));

test('with Herdr offline a conversation can still be suspended; restoring needs the usual confirmation', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.disconnect();
  assert.equal(w.tab(w.A[0]).status, 'unverified');
  assert.equal((await w.suspend(w.A[0])).ok, true);
  const refused = w.pick(w.A[0]);
  assert.deepEqual([refused.ok, refused.error.code], [false, 'confirmation_required']);
  assert.equal(w.manager.isSuspended(w.A[0].conversationKey), true, 'still suspended, nothing created');
  assert.equal(w.pick(w.A[0], { confirm: true }).ok, true);
}));

test('Herdr disconnecting and reconnecting while a restoration is loading changes nothing: one page, no reload, no association', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  w.pick(w.A[0]);
  const back = w.fake.views.at(-1);
  const created = w.fake.views.length;
  const bindingsBefore = JSON.stringify(w.bindings.all().map((b) => [b.bindingId, b.url, b.workspaceIdentity]));
  w.disconnect(); w.navigator.reconcile();
  w.connect(); w.navigator.reconcile();
  back.finishLoad(w.A[0].url);
  await w.clock.advance(6000);
  assert.equal(w.fake.views.length, created);
  assert.deepEqual(back.loads, [w.A[0].url], 'loaded exactly once');
  assert.equal(JSON.stringify(w.bindings.all().map((b) => [b.bindingId, b.url, b.workspaceIdentity])), bindingsBefore);
  assert.equal(w.selectCalls.length, 0);
  assert.equal(w.tab(w.A[0]).relation, 'match');
}));

test('a suspended conversation of a workspace id that was recreated (suspect) needs confirmation, and never opens by itself', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  w.setWorkspaces([ws('w1', 'totally-other', 'D:\elsewhere'), ws('w2', 'app'), ws('w3', 'empty')]);
  w.navigator.reconcile();
  assert.equal(w.tab(w.A[0]).status, 'suspect');
  const n = w.fake.views.length;
  w.navigator.setMode('terminal'); w.navigator.setMode('chat');
  w.select('w2'); w.select('w1');
  assert.equal(w.fake.views.length, n, 'no automatic restoration');
  assert.equal(w.pick(w.A[0]).error.code, 'confirmation_required');
}));

test('restoring in another workspace: the conversation stays in its own workspace; opening it from elsewhere is refused as before', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  w.select('w2');
  assert.equal(w.navigator.getState().tabs.some((t) => t.bindingId === w.A[0].bindingId), false, 'not a tab of w2');
  const r = w.navigator.selectBinding({ bindingId: w.A[0].bindingId, workspaceKey: WK('w2') });
  assert.equal(r.error.code, 'not_in_workspace');
  assert.equal(w.manager.isSuspended(w.A[0].conversationKey), true);
  w.select('w1');
  assert.equal(w.pick(w.A[0]).ok, true);
}));

test('project conversations are recovered from their stored project address', () => {
  const w = setup();
  try {
    // Re-bind conversation 6 through a project route.
    w.select('w1');
    const b = w.bindings.bind(w.args(6, { url: projectUrl(6) })).binding;
    assert.match(b.url, /\/g\/g-p-abc123-demo\/c\//);
    return (async () => {
      await w.open(b);
      await w.open(w.A[1]);
      assert.equal((await w.suspend(b)).ok, true);
      w.pick(b);
      assert.deepEqual(w.fake.views.at(-1).loads, [b.url]);
    })().finally(() => w.cleanup0());
  } catch (e) { w.cleanup0(); throw e; }
});

// ---- residual pages -----------------------------------------------------------------------------------------------------------------------

async function makeResidual(w) {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const key = w.A[0].conversationKey;
  assert.equal(w.bindings.unbind({ bindingId: w.A[0].bindingId }).ok, true);
  w.navigator.releaseConversation(key);
  w.navigator.reconcile();
  return a1;
}

test('a page left over after an unbind is a residual: reported, eligible under the same rules, and recoverable from the exceptional list', () => run(async (w) => {
  const a1 = await makeResidual(w);
  const row = w.lifecycle.inventory().find((r) => r.viewId === a1.id);
  assert.deepEqual([row.kind, row.hasBinding, row.eligible], ['residual', false, true]);
  assert.equal(w.lifecycle.summary().residual, 1);
  assert.equal(w.navigator.getUnbound()[0].lifecycle.eligible, true);
  const r = await w.lifecycle.suspend({ viewId: a1.id });
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'residual');
  const list = w.navigator.getUnbound();
  assert.deepEqual([list.length, list[0].suspended, list[0].viewId], [1, true, a1.id]);
  assert.equal(w.bindings.all().length, 4, 'no binding was created or touched');
  // Restoring it is the user opening it from the list.
  const n = w.fake.views.length;
  const opened = w.navigator.openUnbound({ viewId: a1.id });
  assert.equal(opened.ok, true);
  assert.equal(w.fake.views.length, n + 1);
  assert.deepEqual(w.fake.views.at(-1).loads, [chatUrl(1)]);
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal(w.navigator.openUnbound({ viewId: a1.id }).ok, false, 'the old id no longer names anything');
  assert.equal(w.fake.views.length, n + 1);
}));

test('a residual with a draft or a response in progress is protected like any other page', () => run(async (w) => {
  const a1 = await makeResidual(w);
  w.set(a1, { draft: true });
  const r = await w.lifecycle.suspend({ viewId: a1.id });
  assert.deepEqual([r.ok, r.error.reasons], [false, [REASON.DRAFT]]);
  assert.equal(a1.isDestroyed(), false);
}));

test('a residual without a recoverable identity is kept and reported, never discarded', () => run(async (w) => {
  w.select(null);
  const opened = w.navigator.openUnscoped();
  assert.equal(opened.ok, true);
  w.fake.views[0].finishLoad('https://chatgpt.com/');
  await w.clock.advance(6000);
  w.select('w1');
  assert.notEqual(w.manager.getVisibleId(), opened.viewId);
  const d = w.lifecycle.describe(opened.viewId);
  assert.deepEqual([d.kind, d.eligible, d.reasons.includes(REASON.NO_IDENTITY)], ['residual', false, true]);
  assert.equal(w.lifecycle.summary().unrecoverable, 1);
  assert.equal((await w.lifecycle.suspend({ viewId: opened.viewId })).ok, false);
  assert.equal(w.fake.views[0].isDestroyed(), false);
}));

test('a residual that is later bound becomes a tab, not a second entry in the exceptional list', () => run(async (w) => {
  const a1 = await makeResidual(w);
  assert.equal((await w.lifecycle.suspend({ viewId: a1.id })).ok, true);
  assert.equal(w.navigator.getUnbound().length, 1);
  const again = w.bindings.bind(w.args(1)).binding;
  w.navigator.reconcile();
  assert.equal(w.navigator.getUnbound().length, 0);
  assert.equal(w.tab(again).suspended, true);
}));

// ---- observability at rest ---------------------------------------------------------------------------------------------------------------

test('at rest the lifecycle adds no timer, no probe and no state push', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  assert.equal((await w.suspend(w.A[0])).ok, true);
  await w.clock.advance(1000);
  let pushes = 0;
  const off = w.navigator.onChange(() => { pushes += 1; });
  const statsBefore = w.hub.stats();
  const timers = w.clock.timers.length;
  await w.clock.advance(120000);
  assert.equal(pushes, 0, 'no navigation state change while nothing changes');
  assert.equal(w.clock.timers.length, timers);
  assert.equal(w.hub.stats().observers, 1);
  assert.ok(w.hub.stats().polls >= statsBefore.polls, 'only the remaining observer polls');
  off();
}));

test('suspending and restoring many times leaves no residue: listeners, observers and records stay bounded', () => run(async (w) => {
  await w.open(w.A[0]);
  const keep = await w.open(w.A[1]);
  for (let i = 0; i < 6; i++) {
    assert.equal((await w.suspend(w.A[0])).ok, true, `round ${i}`);
    w.pick(w.A[0]);
    const v = w.fake.views.at(-1);
    v.finishLoad(w.A[0].url);
    await w.clock.advance(6000);
    await w.open(w.A[1]);
  }
  assert.equal(w.manager.list().length, 2);
  assert.equal(w.hub.stats().observers, 2);
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal(keep.contents.listenerCount('did-navigate'), 1);
  assert.equal(w.fake.views.filter((v) => !v.isDestroyed()).length, 2);
  assert.equal(w.clock.timers.length <= 3, true, `pending timers: ${w.clock.timers.length}`);
}));

test('only the lifecycle ever suspends: opening, hiding, switching workspaces and idling never release a view', () => run(async (w) => {
  for (const b of w.A) await w.open(b);
  w.select('w2'); w.select('w1');
  w.navigator.setMode('terminal'); w.navigator.setMode('chat');
  await w.clock.advance(600000);
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal(w.fake.views.filter((v) => v.isDestroyed()).length, 0);
}));

// ---- IPC: chats:suspend -------------------------------------------------------------------------------------------------------------------

const { registerChatsIpc } = require('../src/main/ipc/chats');
const { barModel } = require('../src/shared/chat-nav-view');
const { panelModel } = require('../src/shared/chat-bindings-view');
const { centerModel } = require('../src/shared/activity-view');
const { lifeModel, REASON_TEXT } = require('../src/shared/lifecycle-view');

function ipcFor(w) {
  const handlers = new Map();
  const notified = [];
  registerChatsIpc({
    ipcMain: { handle: (c, fn) => handlers.set(c, fn) },
    trusted: (e) => e.trusted === true || e.overlay === true,
    win: { getChatUrl: () => '', getNavigator: () => w.navigator, getLifecycle: () => w.lifecycle },
    bindings: w.bindings,
    notify: () => notified.push(1),
    lifecycleState: () => w.lifecycle.byBinding()
  });
  return { call: (args, sender = { trusted: true }) => handlers.get('chats:suspend')(sender, args), notified, state: (sender = { trusted: true }) => handlers.get('chats:state')(sender) };
}

test('chats:suspend: strangers get nothing; arguments only name the target; exactly one of bindingId / viewId', () => run(async (w) => {
  const ipc = ipcFor(w);
  await w.open(w.A[0]); await w.open(w.A[1]);
  const id = w.viewOf(w.A[0]).id;
  assert.equal((await ipc.call({ bindingId: w.A[0].bindingId }, { trusted: false })).error.code, 'untrusted');
  assert.equal(w.manager.suspendedList().length, 0);
  for (const bad of [null, [], {}, { bindingId: 7 }, { bindingId: 'b_zz' }, { viewId: 'x' }, { viewId: id, bindingId: w.A[0].bindingId }, { viewId: 'v1; rm -rf' }]) {
    assert.equal((await ipc.call(bad)).error.code, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal(w.manager.suspendedList().length, 0);
  assert.equal((await ipc.call({ bindingId: w.A[2].bindingId })).error.code, 'not_loaded', 'never opened: nothing to suspend');
  assert.equal(w.fake.views.length, 2, 'asking never loads a page');
}));

test('chats:suspend: both the UI window and the overlay may ask; main judges; a refusal carries the reasons and notifies nothing', () => run(async (w) => {
  const ipc = ipcFor(w);
  const a1 = await w.open(w.A[0]); await w.open(w.A[1]);
  w.set(a1, { draft: true });
  const refused = await ipc.call({ bindingId: w.A[0].bindingId }, { overlay: true });
  assert.deepEqual([refused.ok, refused.error.code, refused.error.reasons], [false, 'not_eligible', ['draft']]);
  assert.equal(ipc.notified.length, 0);
  w.set(a1, { draft: false });
  await w.clock.advance(12000);
  const done = await ipc.call({ bindingId: w.A[0].bindingId }, { overlay: true });
  assert.equal(done.ok, true);
  assert.equal(ipc.notified.length, 1);
  assert.equal(a1.isDestroyed(), true);
  assert.equal(ipc.state().lifecycle[w.A[0].bindingId].state, 'suspended');
}));

test('chats:suspend: a page of the exceptional list is named by its view id', () => run(async (w) => {
  const ipc = ipcFor(w);
  const a1 = await makeResidual(w);
  const r = await ipc.call({ viewId: a1.id });
  assert.deepEqual([r.ok, r.kind], [true, 'residual']);
}));

// ---- view-models --------------------------------------------------------------------------------------------------------------------------

test('every reason the policy can give has words, and a page that cannot be suspended is never offered the button', () => {
  for (const code of Object.values(REASON)) assert.ok(REASON_TEXT[code], code);
  const blocked = lifeModel({ state: 'background', eligible: false, reasons: ['draft'] });
  assert.deepEqual([blocked.canSuspend, blocked.reasons], [false, [REASON_TEXT.draft]]);
  assert.match(blocked.help, /rascunho/);
  assert.equal(lifeModel({ state: 'background', eligible: true, reasons: [] }).canSuspend, true);
  assert.equal(lifeModel({ state: 'background', eligible: true, reasons: ['draft'] }).canSuspend, false, 'a reason always wins over the flag');
  assert.equal(lifeModel({ state: 'background', eligible: true, reasons: ['made-up'] }).canSuspend, false);
  assert.equal(lifeModel(null), null);
  const suspended = lifeModel({ state: 'suspended' });
  assert.deepEqual([suspended.canSuspend, suspended.stateText], [false, 'Suspensa (não monitorada)']);
  assert.match(suspended.help, /não é monitorada/);
  assert.match(suspended.help, /Não se sabe/, 'it says it does not know, it never claims idle');
});

test('the strip marks a suspended conversation distinctly (shape and words), never as idle, and explains a blocked one', () => run(async (w) => {
  await w.open(w.A[0]); await w.open(w.A[1]);
  let tab = barModel(w.navigator.getState()).tabs[0];
  assert.match(tab.title, /Ociosa \(observada\)/);
  assert.deepEqual([tab.suspended, tab.status.length], [false, 0]);
  assert.equal(await (async () => (await w.suspend(w.A[0])).ok)(), true);
  tab = barModel(w.navigator.getState()).tabs[0];
  assert.deepEqual([tab.suspended, tab.status.map((s) => s.kind)], [true, ['suspended']]);
  assert.match(tab.title, /Suspensa/);
  assert.doesNotMatch(tab.title, /Ociosa/);
  assert.ok(tab.status[0].glyph.length > 0 && tab.status[0].label === 'Suspensa');
  const active = barModel(w.navigator.getState()).tabs[1];
  assert.deepEqual(active.status.map((s) => s.kind), []);
}));

test('the Gerenciar rows carry the state and the reasons; the activity center offers Suspender only for an eligible residual', () => run(async (w) => {
  const a1 = await w.open(w.A[0]); await w.open(w.A[1]);
  w.set(a1, { draft: true }); await w.clock.advance(6000);
  const stateOf = () => ({ ...w.bindings.getState({ url: '' }), lifecycle: w.lifecycle.byBinding() });
  let rows = panelModel(stateOf(), 'w1').rows;
  const r1 = rows.find((r) => r.bindingId === w.A[0].bindingId);
  assert.deepEqual([r1.life.canSuspend, r1.life.reasons], [false, [REASON_TEXT.draft]]);
  assert.equal(rows.find((r) => r.bindingId === w.A[2].bindingId).life, null, 'never opened: nothing claimed');
  w.set(a1, { draft: false }); await w.clock.advance(6000);
  rows = panelModel(stateOf(), 'w1').rows;
  assert.equal(rows.find((r) => r.bindingId === w.A[0].bindingId).life.canSuspend, true);
  // residuals
  await w.suspend(w.A[0]);
  w.pick(w.A[0]); w.fake.views.at(-1).finishLoad(w.A[0].url); await w.clock.advance(6000); await w.open(w.A[1]);
  w.bindings.unbind({ bindingId: w.A[0].bindingId });
  w.navigator.releaseConversation(w.A[0].conversationKey); w.navigator.reconcile();
  const model = centerModel({ global: w.navigator.getGlobalActivity(), notices: { items: [], more: 0 } });
  assert.deepEqual([model.unbound.items.length, model.unbound.items[0].canSuspend, model.unbound.items[0].suspended], [1, true, false]);
  const rid = model.unbound.items[0].viewId;
  await w.lifecycle.suspend({ viewId: rid });
  const after = centerModel({ global: w.navigator.getGlobalActivity(), notices: { items: [], more: 0 } });
  assert.deepEqual([after.unbound.items[0].canSuspend, after.unbound.items[0].suspended, after.unbound.items[0].stateText], [false, true, 'Suspensa (não monitorada)']);
}));

// ---- resource report ---------------------------------------------------------------------------------------------------------------------

const { buildResourceReport } = require('../src/main/chat-views/resource-report');

test('the resource report never divides a shared process among views, separates host processes from the rest, and carries no content', () => run(async (w) => {
  await w.open(w.A[0]); await w.open(w.A[1]); await w.open(w.A[2]);
  const ids = w.manager.list().map((v) => v.id);
  const metrics = [
    { pid: 10, type: 'Browser', memory: { workingSetSize: 204800 }, cpu: { percentCPUUsage: 1, idleWakeupsPerSecond: 2 } },
    { pid: 20, type: 'Tab', memory: { workingSetSize: 307200, privateBytes: 1024 }, cpu: { percentCPUUsage: 0.5, idleWakeupsPerSecond: 1 } },
    { pid: 30, type: 'Tab', memory: { workingSetSize: 102400 }, cpu: { percentCPUUsage: 0 } },
    { pid: 40, type: 'GPU', memory: { workingSetSize: 51200 }, cpu: { percentCPUUsage: 0.25 } }
  ];
  const report = buildResourceReport({ summary: w.lifecycle.summary(), inventory: w.lifecycle.inventory(), metrics, pids: { [ids[0]]: 20, [ids[1]]: 20, [ids[2]]: 30, vX: 999 }, hubStats: w.hub.stats(), at: 1 });
  const p20 = report.processes.find((p) => p.pid === 20);
  assert.deepEqual([p20.views, p20.shared, p20.workingSetMB], [[ids[0], ids[1]], true, 300], 'shared: both views listed, memory not split');
  assert.equal(report.processes.find((p) => p.pid === 10).views.length, 0);
  assert.deepEqual([report.totals.viewHosts, report.totals.viewHostsMB, report.totals.sharedHosts, report.totals.allWorkingSetMB], [2, 400, 1, 650]);
  assert.deepEqual(report.totals.byType.Tab, { processes: 2, workingSetMB: 400 });
  assert.deepEqual(report.unmappedViews, ['vX']);
  assert.equal(report.views.created, 3);
  assert.ok(report.notes.some((n) => /upper bound/.test(n)));
  assert.doesNotMatch(JSON.stringify(report), /chatgpt\.com|https?:/, 'no address or content');
  assert.deepEqual(buildResourceReport().totals.processes, 0, 'an empty report is valid');
}));
