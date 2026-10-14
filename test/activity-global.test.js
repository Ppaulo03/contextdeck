'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createStatusWorld, bindMany } = require('./helpers/views-world');
const { ws } = require('./helpers/bindings-world');
const { createNoticeController } = require('../src/main/activity/notices');
const { createDirectOpen } = require('../src/main/activity/direct-open');

const WK = (id) => `contextdeck/${id}`;
const RESPONDING = { stop: true };
const IDLE = { stop: false, turnActions: false };

// w1 "api" holds conversations 1-3, w2 "app" holds 4-5, w3 is ANOTHER workspace also called "app" (homonym) holding 6.
function setup(opts = {}) {
  const w = createStatusWorld({ workspaces: [ws('w1', 'api'), ws('w2', 'app'), ws('w3', 'app')], ...opts });
  w.select('w1'); w.A = bindMany(w, [1, 2, 3]);
  w.select('w2'); w.B = bindMany(w, [4, 5]);
  w.select('w3'); w.C = bindMany(w, [6], { label: 'chat 1' });     // same label as A[0]
  w.select('w1');
  w.navigator.setMode('chat');
  w.pick = (b, extra = {}) => w.navigator.selectBinding({ bindingId: b.bindingId, workspaceKey: WK(b.workspaceIdentity.workspaceId), ...extra });
  w.open = async (b) => {
    const wasSelected = w.sel.selected && w.sel.selected.workspaceId;
    const id = b.workspaceIdentity.workspaceId;
    if (wasSelected !== id) w.select(id);
    const r = w.pick(b);
    const view = w.fake.views.find((v) => v.id === r.viewId) || w.fake.views.at(-1);
    view.finishLoad(b.url);
    await w.clock.advance(6000);
    return view;
  };
  w.set = (view, signals) => Object.assign(view.contents.signals, signals);
  w.global = () => w.navigator.getGlobalActivity();
  w.attentionEvents = [];
  w.hub.onAttention((e) => w.attentionEvents.push(e));
  return w;
}
const run = async (fn, opts) => { const w = setup(opts); try { await fn(w); } finally { w.cleanup0(); } };

// ---- the global projection ----------------------------------------------------------------------------------------

test('nothing loaded: no groups, no claims; a conversation that was never loaded is absent (not idle)', () => run((w) => {
  const g = w.global();
  assert.deepEqual(g.totals, { responding: 0, attention: 0, drafts: 0, observed: 0, loaded: 0, suspended: 0 });
  assert.deepEqual(g.groups, []);
  assert.equal(g.selectedId, 'w1');
}));

test('activity in the current workspace and in another one, with two responses at once, shows in the totals and groups', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const b1 = await w.open(w.B[0]);
  w.set(a1, RESPONDING); w.set(b1, RESPONDING);
  await w.clock.advance(6000);
  w.navigator.setMode('terminal');                               // the Terminal tab is showing
  const g = w.global();
  assert.deepEqual([g.totals.responding, g.totals.attention, g.totals.observed, g.totals.loaded], [2, 0, 2, 2]);
  assert.deepEqual(g.groups.map((x) => [x.id, x.label, x.items.map((i) => [i.label, i.responding])]), [['w1', 'api', [['chat 1', true]]], ['w2', 'app', [['chat 4', true]]]]);
  assert.equal(g.selectedId, 'w2', 'independent of the workspace selected');
}));

test('attention, drafts and unknown: only conversations with something to say appear; counts of drafts and observed are totals', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const a2 = await w.open(w.A[1]);
  const a3 = await w.open(w.A[2]);
  w.set(a1, RESPONDING);
  await w.clock.advance(6000);                                    // A1 is hidden: its cadence is 5 s
  w.set(a2, { draft: true });
  w.set(a3, { composer: false });                                // unknown: no composer
  w.pick(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(8000);
  const g = w.global();
  assert.deepEqual([g.totals.attention, g.totals.drafts, g.totals.responding, g.totals.observed], [1, 1, 0, 3]);
  assert.deepEqual(g.groups[0].items.map((i) => [i.label, i.attention, i.draft]), [['chat 1', true, false], ['chat 2', false, true]], 'attention before draft; the unknown one is not listed');
  assert.equal(g.groups[0].items.every((i) => i.openable), true);
}));

test('homonym workspaces are different groups (told apart by id); conversations with the same label stay separate items', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  const c1 = await w.open(w.C[0]);
  const b1 = await w.open(w.B[0]);
  for (const v of [a1, c1, b1]) w.set(v, RESPONDING);
  await w.clock.advance(6000);
  const g = w.global();
  assert.deepEqual(g.groups.map((x) => [x.id, x.label]), [['w1', 'api'], ['w2', 'app'], ['w3', 'app']], 'two workspaces named "app", ordered by id');
  assert.deepEqual(g.groups.flatMap((x) => x.items.map((i) => [x.id, i.label])), [['w1', 'chat 1'], ['w2', 'chat 4'], ['w3', 'chat 1']]);
}));

test('temporary conversations and the unscoped page are listed under their workspace (or none) and are not bindings', () => run(async (w) => {
  const created = w.navigator.newConversation({ workspaceKey: WK('w1') });
  const v = w.fake.views[0];
  v.finishLoad('https://chatgpt.com/');
  await w.clock.advance(6000);
  w.set(v, { draft: true });
  await w.clock.advance(6000);
  const item = w.global().groups[0].items[0];
  assert.deepEqual([item.kind, item.bindingId, item.label, item.draft], ['temporary', null, 'Nova conversa', true]);
  assert.equal(created.ok, true);
}));

test('computing the projection loads, reloads, attaches and creates nothing and writes nothing', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(6000);
  const before = JSON.stringify([w.fake.log.length, w.fake.views.map((v) => v.loads.length), fs.readFileSync(w.file, 'utf8')]);
  for (let i = 0; i < 50; i++) w.global();
  assert.equal(JSON.stringify([w.fake.log.length, w.fake.views.map((v) => v.loads.length), fs.readFileSync(w.file, 'utf8')]), before);
  assert.doesNotMatch(JSON.stringify(w.global()), /chatgpt\.com|https?:/, 'no addresses in the projection');
}));

test('stale readings do not contaminate the totals: a view that navigated to another conversation contributes its NEW state only', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(6000);
  assert.equal(w.global().totals.responding, 1);
  w.set(a1, IDLE);
  a1.navigate(w.A[1].url);                                       // the user opened chat 2 in the same page
  assert.equal(w.global().totals.responding, 0, 'the responding of chat 1 is not carried to chat 2');
  assert.deepEqual(w.global().groups, []);
}));

// ---- new attention events (the source of notices) -------------------------------------------------------------------------

test('a new pending attention is announced exactly once; staying pending does not repeat it', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  assert.equal(w.attentionEvents.length, 1);
  assert.equal(w.attentionEvents[0].viewId, w.manager.list()[0].id);
  await w.clock.advance(60000);
  assert.equal(w.attentionEvents.length, 1, 'still pending: nothing new');
  w.hub.sync(); w.navigator.reconcile();
  assert.equal(w.attentionEvents.length, 1);
}));

test('visit then another response that ends unseen: a second, new event', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  for (let round = 1; round <= 2; round++) {
    w.pick(w.A[0]);
    w.set(a1, RESPONDING);
    await w.clock.advance(4000);
    w.pick(w.A[1]).ok || await w.open(w.A[1]);
    w.set(a1, IDLE);
    await w.clock.advance(6000);
    assert.equal(w.attentionEvents.length, round);
    w.pick(w.A[0]);                                              // the user visits: acknowledged
  }
}));

test('no event for: a response that ends while watched, a reload, a probe timeout, a lost detector, navigation inside the page, startup', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  w.set(a1, IDLE);                                               // watched
  await w.clock.advance(4000);
  assert.equal(w.attentionEvents.length, 0, 'watched');
  const a2 = await w.open(w.A[1]);
  w.set(a2, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[2]);                                          // A2 hidden
  a2.contents.probeError = new Error('lost');
  await w.clock.advance(6000);
  a2.contents.probeError = null;
  a2.contents.hang = true;
  await w.clock.advance(14000);
  a2.contents.hang = false;
  a2.navigate(w.A[0].url);                                       // navigation inside the page
  await w.clock.advance(6000);
  a2.emit('navigation-started'); a2.contents.emit('did-start-navigation', {}, 'https://chatgpt.com/', false, true);   // reload
  await w.clock.advance(6000);
  assert.equal(w.attentionEvents.length, 0);
  assert.equal(w.global().totals.attention, 0);
}));

test('a view that is already pending when first summarized is a baseline, not an event', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  assert.equal(a1.contents.probes >= 1, true);
  const events = [];
  const off = w.hub.onAttention((e) => events.push(e));
  w.hub.sync();
  off();
  assert.deepEqual(events, []);
}));

// ---- notices --------------------------------------------------------------------------------------------------------------------

function noticeClock() {
  let t = 1000; const timers = [];
  return {
    now: () => t, timers,
    setTimer: (fn, ms) => { const x = { fn, at: t + ms, unref() {} }; timers.push(x); return x; },
    clearTimer: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); },
    advance(ms) { t += ms; for (const x of timers.filter((y) => y.at <= t)) { timers.splice(timers.indexOf(x), 1); x.fn(); } }
  };
}
const event = (n, extra = {}) => ({ viewId: `v${n}`, workspaceId: 'w1', workspaceLabel: 'api', label: `chat ${n}`, bindingId: `b_${String(n).padStart(16, '0')}`, kind: 'binding', openable: true, ...extra });

test('notices: newest first, one per view (a repeat refreshes), at most three shown, the rest counted; one timer', () => {
  const c = noticeClock();
  const n = createNoticeController(c);
  for (let i = 1; i <= 5; i++) n.push(event(i));
  let s = n.getState();
  assert.deepEqual(s.items.map((x) => x.label), ['chat 5', 'chat 4', 'chat 3']);
  assert.equal(s.more, 2);
  n.push(event(3));
  s = n.getState();
  assert.deepEqual(s.items.map((x) => x.label), ['chat 3', 'chat 5', 'chat 4'], 'refreshed, not duplicated');
  assert.equal(s.more, 2);
  assert.equal(c.timers.length, 1, 'a single shared timer');
  assert.doesNotMatch(JSON.stringify(s), /https?:|chatgpt/);
});

test('notices expire by themselves; dismissing, expiring or closing never touches the pending attention', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  const c = noticeClock();
  const n = createNoticeController(c);
  n.push(w.attentionEvents.length ? event(1, { viewId: w.attentionEvents[0].viewId }) : event(1));
  assert.equal(w.global().totals.attention, 1);
  n.dismiss(`n:${w.attentionEvents[0].viewId}`);
  assert.equal(n.getState().items.length, 0);
  assert.equal(w.global().totals.attention, 1, 'dismissed: still pending');
  n.push(event(2)); c.advance(9000);
  assert.deepEqual(n.getState(), { items: [], more: 0 });
  assert.equal(c.timers.length, 0, 'no timer left');
  assert.equal(w.global().totals.attention, 1, 'expired: still pending');
}));

test('notices: retain() retires the ones whose attention was acknowledged; clearView and stop() leave nothing behind', () => {
  const c = noticeClock();
  const n = createNoticeController(c);
  n.push(event(1)); n.push(event(2)); n.push(event(3));
  n.retain((x) => x.viewId !== 'v2');
  assert.deepEqual(n.getState().items.map((x) => x.viewId), ['v3', 'v1']);
  n.clearView('v3');
  assert.deepEqual(n.getState().items.map((x) => x.viewId), ['v1']);
  n.stop();
  assert.equal(c.timers.length, 0);
  assert.deepEqual(n.getState(), { items: [], more: 0 });
});

test('notices never call anything that could acknowledge attention or open a conversation (module-level guarantee)', () => {
  const src = fs.readFileSync(require.resolve('../src/main/activity/notices.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(src, /visit|markViewed|select|focus|loadURL|require\(/);
});

// ---- direct navigation ----------------------------------------------------------------------------------------------------------

function direct(w, { mode = 'terminal' } = {}) {
  const calls = { showChatTab: 0 };
  const state = { mode };
  const d = createDirectOpen({
    session: w.session,
    selection: w.selection,
    navigator: w.navigator,
    showChatTab: () => { calls.showChatTab += 1; state.mode = 'chat'; w.navigator.setMode('chat'); },
    getMode: () => state.mode
  });
  return { d, calls, state };
}

test('opening a conversation of the workspace already selected: no workspace command, the chat tab is shown, the loaded view is reused and the attention is cleared', () => run(async (w) => {
  const a1 = await w.open(w.A[0]);
  w.set(a1, RESPONDING);
  await w.clock.advance(4000);
  await w.open(w.A[1]);
  w.set(a1, IDLE);
  await w.clock.advance(6000);
  assert.equal(w.global().totals.attention, 1);
  const { d, calls, state } = direct(w, { mode: 'terminal' });
  w.navigator.setMode('terminal');
  const loads = w.fake.views.map((v) => v.loads.length);
  const r = await d.open({ workspaceId: 'w1', bindingId: w.A[0].bindingId });
  assert.equal(r.ok, true);
  assert.deepEqual(w.selectCalls, [], 'no Herdr command: the workspace was already the selected one');
  assert.equal(calls.showChatTab, 1);
  assert.equal(state.mode, 'chat');
  assert.deepEqual(w.fake.views.map((v) => v.loads.length), loads, 'no reload, no new view');
  assert.equal(w.navigator.getState().tabs[0].active, true);
  assert.equal(w.global().totals.attention, 0, 'the visit (same rule as everywhere) acknowledged it');
}));

test('opening a conversation of ANOTHER workspace: explicit selection first, then the chat tab, then the conversation; the loaded view is reused', () => run(async (w) => {
  const b1 = await w.open(w.B[0]);
  w.set(b1, RESPONDING);
  await w.clock.advance(4000);
  w.select('w1');
  w.set(b1, IDLE);
  await w.clock.advance(6000);
  assert.equal(w.global().totals.attention, 1);
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const loads = w.fake.views.map((v) => v.loads.length);
  const before = fs.readFileSync(w.file, 'utf8');
  const r = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  assert.equal(r.ok, true);
  assert.equal(r.switched, true);
  assert.deepEqual(w.selectCalls, [['contextdeck', 'w2']], 'one explicit selection');
  assert.equal(calls.showChatTab, 1);
  assert.equal(w.sel.selected.workspaceId, 'w2');
  assert.equal(w.navigator.getState().workspace.id, 'w2');
  assert.equal(w.navigator.getState().tabs[0].active, true);
  assert.deepEqual(w.fake.views.map((v) => v.loads.length), loads, 'no reload');
  assert.equal(w.global().totals.attention, 0);
  assert.equal(fs.readFileSync(w.file, 'utf8'), before, 'no binding created or changed');
}));

test('the workspace command fails: the chat tab is not shown, nothing is selected, no conversation appears under a wrong context', () => run(async (w) => {
  await w.open(w.B[0]);
  w.select('w1');
  w.setSelectImpl(async () => ({ ok: false, error: { code: 'workspace_not_found', message: 'Esse workspace nao existe mais na sessao.' } }));
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const r = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'workspace_not_found');
  assert.match(r.error.message, /A conversa nao foi aberta/);
  assert.equal(r.error.workspaceChanged, false);
  assert.equal(calls.showChatTab, 0);
  assert.equal(w.sel.selected.workspaceId, 'w1');
  assert.equal(w.navigator.getState().tabs.some((t) => t.active), false);
}));

test('the controller answers ok but settles on another workspace (Auto followed the observed focus): the conversation is not shown under it', () => run(async (w) => {
  await w.open(w.B[0]);
  w.select('w1');
  w.setSelectImpl(async () => { w.sel.selected = { workspaceId: 'w3', origin: 'herdr' }; return { ok: true, confirmed: false }; });
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const r = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  assert.equal(r.error.code, 'context_changed');
  assert.equal(r.error.workspaceChanged, true, 'honest about the partial outcome: Herdr did move');
  assert.equal(calls.showChatTab, 0);
  assert.equal(w.navigator.getState().tabs.some((t) => t.active), false);
}));

test('suspect and unverified bindings need an explicit confirmation BEFORE anything is sent; orphans and unknown targets never open', () => run(async (w) => {
  await w.open(w.B[0]);
  w.select('w1');
  w.setWorkspaces([ws('w1', 'api'), ws('w2', 'totally-other', 'D:\\elsewhere'), ws('w3', 'app')]);   // w2 recreated
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const refused = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  assert.equal(refused.error.code, 'confirmation_required');
  assert.equal(refused.error.status, 'suspect');
  assert.deepEqual(w.selectCalls, [], 'no workspace command without the confirmation');
  assert.equal(calls.showChatTab, 0);
  assert.equal((await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId, confirm: 'true' })).error.code, 'confirmation_required', 'only the boolean true confirms');
  assert.equal((await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId, confirm: true })).ok, true);
  assert.deepEqual(w.selectCalls, [['contextdeck', 'w2']]);
  // Orphan: the workspace disappeared.
  w.setWorkspaces([ws('w1', 'api'), ws('w3', 'app')]);
  w.select('w1');
  w.selectCalls.length = 0;
  const gone = await d.open({ workspaceId: 'w2', bindingId: w.B[1].bindingId, confirm: true });
  assert.equal(gone.error.code, 'not_available');
  assert.deepEqual(w.selectCalls, []);
  assert.equal((await d.open({ workspaceId: 'w1', bindingId: w.B[0].bindingId })).error.code, 'target_not_found', 'a binding of another workspace is not found under this one');
  assert.equal((await d.open({ workspaceId: 'w1', bindingId: 'b_ffffffffffffffff' })).error.code, 'target_not_found');
}));

test('Herdr disconnected: unverified bindings also need the confirmation', () => run(async (w) => {
  await w.open(w.A[0]);
  w.disconnect();
  const { d } = direct(w);
  const r = await d.open({ workspaceId: 'w1', bindingId: w.A[0].bindingId });
  assert.equal(r.error.code, 'confirmation_required');
  assert.equal(r.error.status, 'unverified');
}));

test('a second request while the first switch is in flight is refused; the first one is still served when it settles', () => run(async (w) => {
  await w.open(w.A[0]); await w.open(w.B[0]); await w.open(w.C[0]);
  w.select('w1');
  let release;
  w.setSelectImpl((s, id) => { w.sel.pending = { workspaceId: id }; return new Promise((resolve) => { release = () => { w.sel.pending = null; w.sel.selected = { workspaceId: id, origin: 'dock' }; w.select(id); resolve({ ok: true, confirmed: true }); }; }); });
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const first = d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  const second = await d.open({ workspaceId: 'w3', bindingId: w.C[0].bindingId });
  assert.equal(second.error.code, 'selection_pending');
  assert.equal(w.selectCalls.length, 1, 'no second command');
  release();
  const r1 = await first;
  assert.equal(r1.ok, true, 'the refused request did not invalidate the one being served');
  assert.equal(calls.showChatTab, 1);
  assert.equal(w.navigator.getState().workspace.id, 'w2');
}));

test('a request that is overtaken after it started (a newer one acted) is superseded: its late answer changes nothing and nothing is shown under a context it did not choose', () => run(async (w) => {
  await w.open(w.A[0]); await w.open(w.B[0]); await w.open(w.C[0]);
  w.select('w1');
  const gates = [];
  // A controller that tolerates overlapping commands (no `pending` flag): the older command also takes effect, late.
  w.setSelectImpl((s, id) => new Promise((resolve) => gates.push(() => { w.sel.selected = { workspaceId: id, origin: 'dock' }; w.select(id); resolve({ ok: true, confirmed: true }); })));
  const { d, calls } = direct(w);
  w.navigator.setMode('terminal');
  const first = d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  const second = d.open({ workspaceId: 'w3', bindingId: w.C[0].bindingId });
  gates[1]();                                                   // the newer one answers first
  const r2 = await second;
  gates[0]();                                                   // the older one answers late
  const r1 = await first;
  assert.equal(r2.ok, true);
  assert.equal(r1.superseded, true);
  assert.equal(calls.showChatTab, 1, 'only the latest request shows anything');
  const st = w.navigator.getState();
  const attached = [...w.fake.host.attached].map((id) => w.manager.get(id));
  assert.ok(attached.every((v) => v.scope === (st.workspace ? WK(st.workspace.id) : null)), 'whatever is on screen belongs to the workspace shown');
}));

test('a switch already in flight is refused (no second command); the conversation opens fine once it settles', () => run(async (w) => {
  await w.open(w.B[0]);
  w.select('w1');
  w.sel.pending = { workspaceId: 'w3' };
  const { d } = direct(w);
  const r = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  assert.equal(r.error.code, 'selection_pending');
  assert.deepEqual(w.selectCalls, []);
  w.sel.pending = null;
  assert.equal((await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId })).ok, true);
}));

test('failure after the switch is reported as partial (the workspace did change), and nothing is loaded or bound', () => run(async (w) => {
  w.navigator.setMode('terminal');
  const { d } = direct(w);
  const orig = w.navigator.selectBinding;
  w.navigator.selectBinding = () => ({ ok: false, error: { code: 'open_failed', message: 'Nao foi possivel abrir a conversa.' } });
  const r = await d.open({ workspaceId: 'w2', bindingId: w.B[0].bindingId });
  w.navigator.selectBinding = orig;
  assert.equal(r.ok, false);
  assert.equal(r.workspaceChanged, true);
  assert.match(r.error.message, /O workspace foi trocado, mas a conversa nao foi aberta/);
}));

test('temporary conversations of another workspace open through the same safe flow', () => run(async (w) => {
  const created = w.navigator.newConversation({ workspaceKey: WK('w1') });
  w.select('w2');
  w.navigator.setMode('terminal');
  const { d } = direct(w);
  assert.equal(created.ok, true);
  const r = await d.open({ workspaceId: 'w1', viewId: created.viewId });
  assert.equal(r.ok, true);
  assert.equal(w.navigator.getState().workspace.id, 'w1');
  assert.equal(w.navigator.getState().activeViewId, created.viewId);
  assert.equal((await d.open({ workspaceId: 'w2', viewId: created.viewId })).error.code, 'target_not_found', 'a view scoped to w1 cannot be opened as w2\'s');
}));

test('opening never reloads, destroys or creates a view when the conversation is already loaded, and never calls anything but the explicit selection', () => run(async (w) => {
  await w.open(w.A[0]); await w.open(w.B[0]);
  w.select('w1');
  const { d } = direct(w);
  w.navigator.setMode('terminal');
  const snapshot = w.fake.views.length;
  for (let i = 0; i < 6; i++) await d.open({ workspaceId: i % 2 ? 'w1' : 'w2', bindingId: (i % 2 ? w.A[0] : w.B[0]).bindingId });
  assert.equal(w.fake.views.length, snapshot);
  assert.equal(w.fake.log.some((l) => l[0] === 'destroy'), false);
  assert.deepEqual(w.fake.views.map((v) => v.loads.length), [1, 1]);
  const src = fs.readFileSync(require.resolve('../src/main/activity/direct-open.js'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
  assert.equal([...src.matchAll(/\bselection\.select\(/g)].length, 1, 'the only Herdr write is the explicit selection');
  assert.doesNotMatch(src, /focusWorkspace|workspace\.focus|loadURL|bindings\.|\.bind\(|reassign/);
}));
