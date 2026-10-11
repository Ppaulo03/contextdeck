'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createStatusWorld, bindMany, HOME } = require('./helpers/views-world');
const { ws, chatUrl, projectUrl, ID } = require('./helpers/bindings-world');

const WK = (id) => `contextdeck/${id}`;
const RESPONDING = { stop: true };
const IDLE = { stop: false, turnActions: false };

// Real I3P detector + model on fake contents, virtual time; workspace w1 holds conversations 1-3, w2 holds 4-5.
function setup(opts = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app'), ws('w3', 'empty')], ...opts });
  w.select('w1');
  w.A = bindMany(w, [1, 2, 3]);
  w.select('w2');
  w.B = bindMany(w, [4, 5]);
  w.select('w1');
  w.navigator.setMode('chat');
  w.pick = (b, extra = {}) => w.navigator.selectBinding({ bindingId: b.bindingId, workspaceKey: WK(b.workspaceIdentity.workspaceId), ...extra });
  // Opens a conversation and lets its page "load" on it, then lets the first probes run.
  w.open = async (b) => {
    const r = w.pick(b);
    const view = w.fake.views.find((v) => v.id === w.manager.get(r.viewId).id) || w.fake.views.at(-1);
    view.finishLoad(b.url);
    await w.clock.advance(6000);
    return view;
  };
  w.tab = (b) => w.navigator.getState().tabs.find((t) => t.bindingId === b.bindingId);
  w.set = (view, signals) => Object.assign(view.contents.signals, signals);
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };

// ---- observers follow views ---------------------------------------------------------------------------------------

test('an observer exists only for a loaded view; bindings that were never opened have no status (not "idle")', () => run(async (w) => {
  assert.equal(w.hub.stats().observers, 0);
  assert.deepEqual(w.navigator.getState().tabs.map((t) => t.activity), [null, null, null]);
  const v = await w.open(w.A[0]);
  assert.equal(w.hub.stats().observers, 1);
  assert.equal(w.started.length, 1);
  assert.equal(w.tab(w.A[0]).activity.phase, 'ready');
  assert.equal(w.tab(w.A[1]).activity, null, 'unloaded: nothing claimed');
  assert.equal(w.tab(w.A[0]).activity.responding, false);
  assert.ok(v.contents.probes >= 1);
}));

test('the same view is never observed twice, however often the manager changes; no duplicate timers', () => run(async (w) => {
  await w.open(w.A[0]);
  await w.open(w.A[1]);
  for (let i = 0; i < 25; i++) { w.hub.sync(); w.navigator.reconcile(); w.pick(w.A[i % 2]); }
  assert.equal(w.started.length, 2);
  assert.equal(w.hub.stats().observers, 2);
  // Pending timers: one poll timer per observer and the shared sweep, nothing else.
  assert.ok(w.clock.timers.length <= 3, `pending timers: ${w.clock.timers.length}`);
  assert.equal(w.fake.views[0].contents.listenerCount('did-navigate'), 1);
}));

test('first polls of different views are spread apart (no simultaneous probes)', () => run(async (w) => {
  w.pick(w.A[0]); w.pick(w.A[1]); w.pick(w.A[2]);
  w.fake.views.forEach((v) => v.finishLoad());
  await w.clock.advance(1);
  const firsts = w.clock.timers.filter((t) => t.ms >= 300 && t.ms < 5000).map((t) => t.ms);
  assert.equal(new Set(firsts).size, firsts.length, JSON.stringify(firsts));
}));

// ---- generation, draft, attention ---------------------------------------------------------------------------------

test('a response is shown as responding with observed evidence; two views respond independently', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const a2 = await w.open(w.A[1]);
  w.set(a1, RESPONDING); w.set(a2, RESPONDING);
  await w.clock.advance(6000);
  assert.deepEqual([w.tab(w.A[0]).activity.responding, w.tab(w.A[1]).activity.responding], [true, true]);
  assert.equal(w.hub.summaryOf(w.manager.list()[0].id).evidence, 'observed');
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  assert.deepEqual([w.tab(w.A[0]).activity.responding, w.tab(w.A[1]).activity.responding], [false, true], 'only A1 stopped');
}));

test('a response that ends while the view is hidden leaves attention pending, as ended-unclassified (never "completed")', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);                                    // the user moves to A2: A1 is hidden
  w.set(a1, IDLE);                                         // the stop control disappears
  await w.clock.advance(6000);
  const act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.ended], [false, true, true]);
  assert.equal(w.hub.summaryOf(w.manager.list()[0].id).generation, 'ended-unclassified');
  assert.equal(w.hub.runtimeOf(w.manager.list()[0].id).generation.value, 'ended-unclassified');
  assert.equal(w.tab(w.A[1]).activity.attention, false, 'the other view is unaffected');
}));

test('"completed" appears only with its own corroborating evidence (a finished-turn action), and still raises attention only when hidden', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, { stop: false, turnActions: true });
  await w.clock.advance(6000);
  const s = w.hub.summaryOf(w.manager.list()[0].id);
  assert.deepEqual([s.generation, s.evidence, s.attention], ['completed', 'inferred', 'pending']);
}));

test('a response that ends while the user is looking at the view needs no attention', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  w.set(a1, IDLE);
  await w.clock.advance(4000);
  assert.deepEqual([w.tab(w.A[0]).activity.attention, w.tab(w.A[0]).activity.ended], [false, true]);
}));

test('the window not being interactive (minimized, unfocused) counts as "not looking": a response that ends then is pending', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);                         // visible, window interactive
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  w.hub.setInteractive(false);                             // minimized / alt-tabbed away
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]).activity.attention, true);
  // Coming back (window focus with the view on screen) is a visit.
  w.hub.setInteractive(true);
  assert.equal(w.navigator.visitVisible(), true);
  assert.equal(w.tab(w.A[0]).activity.attention, false);
}));

test('attention is cleared only by a visit: not by selecting the workspace, creating or preloading a view, nor by data selection', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  w.select('w2');                                          // A1 hidden (other workspace)
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]) === undefined, true, 'its tab belongs to w1');
  assert.equal(w.navigator.getWorkspaceActivity().w1.attention, 1);
  // Back in w1 the last conversation is restored automatically (a reconcile, not a user action): still pending.
  w.select('w1');
  assert.equal(w.manager.getVisibleId() !== null, true);
  assert.equal(w.tab(w.A[0]).active, true);
  assert.equal(w.tab(w.A[0]).activity.attention, true, 'showing it by itself is not a visit');
  // Creating/preloading other views changes nothing.
  await w.open(w.A[1]);
  assert.equal(w.tab(w.A[0]).activity.attention, true);
  // An explicit selection of the tab is a visit.
  w.pick(w.A[0]);
  assert.equal(w.tab(w.A[0]).activity.attention, false);
}));

test('a visit while the window is not interactive does not acknowledge anything', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  w.hub.setInteractive(false);
  w.pick(w.A[0]);
  assert.equal(w.tab(w.A[0]).activity.attention, true, 'minimized: the user cannot see it');
  w.hub.setInteractive(true);
  w.navigator.visitVisible();
  assert.equal(w.tab(w.A[0]).activity.attention, false);
}));

test('a draft is shown independently of generation and attention (both can be present); only its presence is read', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, { draft: true });
  await w.clock.advance(6000);
  assert.deepEqual([w.tab(w.A[0]).activity.draft, w.tab(w.A[0]).activity.responding], [true, false]);
  w.set(a1, { ...RESPONDING });
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  const act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.draft, act.attention], [true, true], 'draft + pending activity at once');
  w.set(a1, { draft: false });
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]).activity.draft, false);
  const state = JSON.stringify(w.navigator.getState());
  assert.doesNotMatch(state, /rascunho|prompt|message/i);
}));

// ---- uncertainty: never a false "finished" ------------------------------------------------------------------------

test('a response too short to be seen (never observed responding) produces no attention', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(20000);
  assert.deepEqual([w.tab(w.A[0]).activity.attention, w.tab(w.A[0]).activity.ended], [false, false]);
}));

test('losing the detector, a missing composer or a probe error while responding never raises attention; the state degrades to unknown', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  a1.contents.probeError = new Error('world gone');          // the probe throws
  await w.clock.advance(6000);
  let act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.uncertain], [true, false, true], 'a failing probe is not an ending: the response is kept, flagged uncertain');
  a1.contents.probeError = null;
  w.set(a1, { composer: false, stop: false });              // DOM changed: no composer
  await w.clock.advance(6000);
  act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.uncertain], [true, false, true]);
  w.set(a1, { composer: null, stop: null, draft: null });   // signals not determinable
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]).activity.attention, false);
  await w.clock.advance(40000);                             // a long run of nothing usable: the claim is dropped, still no attention
  act = w.tab(w.A[0]).activity;
  assert.deepEqual([act.responding, act.attention, act.unknown], [false, false, true]);
  assert.equal(w.hub.stats().signalsLost > 0, true);
}));

test('a probe that never answers times out and polling continues (the chain is not lost)', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const before = a1.contents.probes;
  a1.contents.hang = true;
  await w.clock.advance(6000);                              // probe starts and hangs
  await w.clock.advance(6000);                              // timeout (5 s) fires
  assert.equal(w.hub.stats().probeTimeouts >= 1, true);
  a1.contents.hang = false;
  await w.clock.advance(12000);
  assert.ok(a1.contents.probes > before + 1, 'probing resumed');
  assert.equal(w.tab(w.A[0]).activity.unknown, false);
}));

test('an old reading expires: if the probes stop answering the tab does not keep claiming "responding"', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  assert.equal(w.tab(w.A[0]).activity.responding, true);
  a1.contents.hang = true;                                  // renderer frozen: no new answers
  await w.clock.advance(60000);
  const act = w.tab(w.A[0]).activity;
  assert.equal(act.responding, false);
  assert.equal(act.attention, false, 'expiry is uncertainty, not an ended response');
}));

test('a page that is loading shows no status; a view that failed to load is reported by the tab, not as unknown activity', () => run(async (w) => {
  const r = w.pick(w.A[0]);
  await w.clock.advance(1000);
  assert.equal(w.tab(w.A[0]).loading, true);
  assert.equal(w.tab(w.A[0]).activity, null, 'while loading nothing is claimed (not "unknown", not "idle")');
  w.fake.views[0].failLoad();
  await w.clock.advance(100);
  assert.equal(w.tab(w.A[0]).failed, true);
  assert.ok(r.ok);
}));

// ---- identity -----------------------------------------------------------------------------------------------------

test('navigating from conversation A to B inside the view: A\'s status is dropped, nothing is attributed to B until B is observed', () => run(async (w) => {
  const v = await w.open(w.A[0]);
  w.set(v, { ...RESPONDING, draft: true });
  await w.clock.advance(4000);
  assert.equal(w.tab(w.A[0]).activity.responding, true);
  const held = new Promise((resolve) => { v.contents.release = resolve; });
  v.contents.probeGate = held;                              // the next probe answer will arrive late
  await w.clock.advance(2000);                              // a probe for A is now in flight
  w.set(v, { stop: false, draft: false });                 // what B's page looks like
  v.navigate(chatUrl(2));                                   // the user opened B from ChatGPT's sidebar
  v.contents.probeGate = null;
  assert.equal(w.tab(w.A[0]).activity, null, 'A\'s tab does not show anything about this page any more');
  assert.equal(w.tab(w.A[1]).activity.responding, false, 'nothing from A leaked into B');
  v.contents.release();                                     // the late answer about A arrives
  await w.clock.advance(1);
  assert.equal(w.tab(w.A[1]).activity.responding, false, 'a stale result cannot overwrite B');
  assert.equal(w.tab(w.A[1]).activity.attention, false);
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[1]).activity.draft, false);
  assert.equal(w.tab(w.A[0]).activity, null);
  const file = fs.readFileSync(w.file, 'utf8');
  assert.equal(JSON.parse(file).bindings.length, 5, 'bindings untouched');
}));

test('a new chat that receives its address while responding keeps its state and is not bound; one that changes conversation does not', () => run(async (w) => {
  const created = w.navigator.newConversation({ workspaceKey: WK('w1') });
  const v = w.fake.views[0];
  v.finishLoad(HOME);
  await w.clock.advance(6000);
  const before = fs.readFileSync(w.file, 'utf8');
  w.set(v, RESPONDING);
  await w.clock.advance(4000);
  v.navigate(chatUrl(8));                                   // first message sent: /c/<id> in-page
  const s = w.navigator.getState().temporaries[0];
  assert.deepEqual([s.activity.responding, s.label], [true, 'Conversa']);
  assert.equal(fs.readFileSync(w.file, 'utf8'), before, 'nothing was bound');
  assert.ok(created.ok);
  v.navigate(chatUrl(9));                                   // another conversation
  assert.equal(w.navigator.getState().temporaries[0].activity.responding, false);
}));

test('project routes and plain routes are one identity for the status as well', () => run(async (w) => {
  const v = await w.open(w.A[0]);
  w.set(v, RESPONDING);
  await w.clock.advance(4000);
  v.navigate(projectUrl(1));
  await w.clock.advance(100);
  assert.equal(w.tab(w.A[0]).activity.responding, true, 'same conversation, nothing reset');
}));

test('a redirect away from the conversation (placeholder that never showed it) reports no status for the tab', () => run(async (w) => {
  const r = w.pick(w.A[0]);
  const v = w.fake.views[0];
  v.finishLoad(w.A[0].url);
  await w.clock.advance(300);
  v.navigate('https://chatgpt.com/');                       // SPA redirect after load
  await w.clock.advance(6000);
  assert.equal(w.tab(w.A[0]).activity, null);
  assert.ok(r.ok);
}));

// ---- lifecycle ------------------------------------------------------------------------------------------------------

test('hidden (detached) views keep being observed, without being re-attached or touched; re-attaching changes nothing', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const attachesBefore = w.fake.log.filter((l) => l[0] === 'attach').length;
  const probes = a1.contents.probes;
  w.set(a1, RESPONDING);
  await w.clock.advance(30000);
  assert.ok(a1.contents.probes > probes + 3, 'polling goes on while detached');
  assert.equal(w.tab(w.A[0]).activity.responding, true);
  assert.equal(w.fake.log.filter((l) => l[0] === 'attach').length, attachesBefore, 'observing re-attached nothing');
  assert.equal(w.fake.log.filter((l) => l[0] === 'load').length, 2, 'and loaded nothing');
  w.navigator.setMode('terminal');
  await w.clock.advance(10000);
  assert.equal(w.tab(w.A[0]).activity.responding, true);
  assert.equal(w.started.length, 2, 'no observer restarted by detach/attach');
}));

test('a destroyed view takes its observer, timers and listeners with it', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  const timersBefore = w.clock.timers.length;
  const contents = a1.contents;
  w.manager.destroyAll();
  await w.clock.advance(10);
  assert.equal(w.hub.stats().observers, 0);
  assert.equal(contents.eventNames().reduce((n, name) => n + contents.listenerCount(name), 0), 0, 'no listener left on the closed view');
  assert.ok(w.clock.timers.length < timersBefore);
  assert.equal(w.hub.stats().sweepArmed, false);
}));

test('hub.stop() removes every observer, listener and timer', () => run(async (w) => {
  const a = await w.open(w.A[0]);
  await w.open(w.A[1]);
  w.hub.stop();
  assert.equal(w.clock.timers.length, 0);
  assert.equal(a.contents.eventNames().reduce((n, name) => n + a.contents.listenerCount(name), 0), 0);
  const probes = a.contents.probes;
  await w.clock.advance(60000);
  assert.equal(a.contents.probes, probes, 'nothing polls after stop');
}));

test('the observer of a view can be restarted by creating it again; the old one cannot answer for the new identity', () => run(async (w) => {
  const first = await w.open(w.A[0]);
  w.set(first, RESPONDING);
  await w.clock.advance(4000);
  w.fake.views[0].navigate('https://chatgpt.com/');          // it left its conversation: the model resets
  await w.clock.advance(100);
  const second = w.pick(w.A[0]);                              // a fresh view for the tab (the first one did reach it)
  assert.ok(second.ok);
  assert.equal(w.tab(w.A[0]).activity, null, 'the fresh view is loading: nothing carried over from the old page');
}));

// ---- no traffic when nothing changes ---------------------------------------------------------------------------------------

test('steady state sends nothing: 200 polls of unchanged views cause no UI updates; a change causes exactly one', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  await w.open(w.A[1]);
  let updates = 0;
  w.navigator.onChange(() => { updates += 1; });
  const polls = w.hub.stats().polls;
  await w.clock.advance(120000);
  assert.ok(w.hub.stats().polls - polls >= 20, 'it did poll');
  assert.equal(updates, 0, 'unchanged status: no update');
  w.set(a1, { draft: true });
  await w.clock.advance(6000);
  assert.equal(updates, 1);
}));

// ---- workspace aggregation ----------------------------------------------------------------------------------------------

test('per-workspace activity: derived from loaded views only, independent of the workspace on screen, never claimed for unopened chats', () => run(async (w) => {
  assert.deepEqual(w.navigator.getWorkspaceActivity(), {}, 'nothing loaded: no claims at all');
  const a1 = await w.open(w.A[0]);
  const a2 = await w.open(w.A[1]);
  w.set(a1, RESPONDING); w.set(a2, { ...RESPONDING, draft: true });
  await w.clock.advance(6000);
  w.select('w2');                                           // the user works in B
  const b = await w.open(w.B[0]);
  assert.deepEqual(w.navigator.getWorkspaceActivity().w1, { responding: 2, attention: 0, drafts: 1, loaded: 2, observed: 2 });
  assert.deepEqual(w.navigator.getWorkspaceActivity().w2, { responding: 0, attention: 0, drafts: 0, loaded: 1, observed: 1 });
  assert.equal('w3' in w.navigator.getWorkspaceActivity(), false, 'a workspace without loaded chats says nothing');
  w.set(a1, IDLE); w.set(a2, IDLE);
  await w.clock.advance(6000);
  assert.deepEqual(w.navigator.getWorkspaceActivity().w1, { responding: 0, attention: 2, drafts: 1, loaded: 2, observed: 2 });
  assert.ok(b);
  const json = JSON.stringify(w.navigator.getWorkspaceActivity());
  assert.doesNotMatch(json, /chatgpt|label|c:/);
}));

test('workspace counts are not persisted anywhere', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  assert.doesNotMatch(fs.readFileSync(w.file, 'utf8'), /responding|attention|activity/);
  assert.equal(w.last[WK('w1')], w.A[0].bindingId);
}));

// ---- failures never disturb navigation ---------------------------------------------------------------------------------------

test('an observer that cannot start, or one that throws, changes nothing about views, bindings or navigation', () => run(async (w) => {
  const broken = setup({ startObserver: () => { throw new Error('no observer for you'); } });
  try {
    const before = fs.readFileSync(broken.file, 'utf8');
    assert.ok(broken.pick(broken.A[0]).ok);
    broken.fake.views[0].finishLoad();
    await broken.clock.advance(60000);
    assert.equal(broken.pick(broken.A[1]).ok, true);
    assert.equal(broken.pick(broken.A[0]).ok, true);
    assert.equal(broken.fake.views.length, 2);
    assert.equal(broken.fake.log.some((l) => l[0] === 'destroy'), false);
    assert.deepEqual(broken.fake.views.map((v) => v.loads.length), [1, 1]);
    assert.equal(fs.readFileSync(broken.file, 'utf8'), before);
    assert.equal(broken.tab(broken.A[0]).activity, null, 'no status, no pretending');
    assert.equal(broken.hub.stats().observers, 0);
  } finally { broken.cleanup0(); }
  assert.ok(w);
}));

test('a probe error storm does not create, load, reload or destroy anything and navigation keeps working', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const a2 = await w.open(w.A[1]);
  a1.contents.probeError = new Error('boom'); a2.contents.probeError = new Error('boom');
  await w.clock.advance(120000);
  assert.equal(w.pick(w.A[0]).ok && w.pick(w.A[1]).ok, true);
  assert.deepEqual(w.fake.views.map((v) => v.loads.length), [1, 1]);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
}));

test('observation reads no content: the probe result the hub keeps contains only the booleans of the signals', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  a1.contents.signals.leakedText = 'secret prompt text';
  await w.clock.advance(6000);
  const dump = JSON.stringify([w.hub.summaryOf(w.manager.list()[0].id), w.hub.runtimeOf(w.manager.list()[0].id), w.navigator.getState()]);
  assert.doesNotMatch(dump, /secret prompt text/);
}));

test('the runtime provider returns the live dimensions by binding id (generation, draft, attention), never persisted', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, { ...RESPONDING, draft: true });
  await w.clock.advance(6000);
  const r = w.navigator.runtime.getRuntime(w.A[0].bindingId);
  assert.deepEqual([r.generation.value, r.draft.value, r.attention.value], ['responding', 'present', 'none']);
  assert.equal(r.generation.source, 'dom-probe');
  assert.ok(r.generation.validUntil > r.generation.observedAt);
  assert.equal(w.navigator.runtime.getRuntime(w.A[1].bindingId), null);
  assert.equal(ID(1).length, 36);
}));
