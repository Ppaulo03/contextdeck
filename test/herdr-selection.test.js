'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkspaceSelection } = require('../src/main/herdr/workspace-selection');
const { world, settle } = require('./helpers/observer-world');

const SESSION = 'contextdeck';
const THREE = [[1, 'api'], [2, 'web'], [3, 'docs']];

// A started observer + selection on the fake Herdr, with an in-memory preference store.
async function make({ mode = 'auto', last = null, workspaces = THREE, focused = 1 } = {}) {
  const w = world({ session: SESSION, workspaces, focused });
  const prefs = {
    value: { mode, lastWorkspace: last },
    writes: [],
    get() { return this.value; },
    set(patch) { Object.assign(this.value, patch); this.writes.push(patch); }
  };
  const selection = createWorkspaceSelection({ session: SESSION, observer: w.observer, preferences: prefs, now: w.now });
  const changes = [];
  selection.onChange((s) => changes.push(s));
  selection.start();
  w.observer.start();
  await settle();
  return { w, selection, prefs, changes, state: () => selection.getState() };
}
const selectedId = (s) => (s.selected ? s.selected.workspaceId : null);
const stop = ({ w, selection }) => { selection.stop(); w.observer.stop(); };

test('valid selection from the dropdown: focus is sent once, state is reconciled with a fresh snapshot, choice is persisted', async () => {
  const ctx = await make();
  const { w, selection, prefs } = ctx;
  assert.equal(selectedId(ctx.state()), 'w1', 'auto mode starts on the observed focus');
  w.requestLog.length = 0;
  const result = await selection.select(SESSION, 'w3');
  assert.deepEqual(result, { ok: true, confirmed: true, observedId: 'w3' });
  assert.deepEqual(w.focusCalls, ['w3']);
  assert.deepEqual(w.requestLog, ['focus:w3', 'session.snapshot'], 'confirmation comes from a snapshot read AFTER the command');
  const s = ctx.state();
  assert.equal(selectedId(s), 'w3');
  assert.equal(s.selected.origin, 'dock');
  assert.equal(s.pending, null);
  assert.equal(s.observedId, 'w3');
  assert.deepEqual(prefs.value.lastWorkspace, { session: SESSION, workspaceId: 'w3' });
  stop(ctx);
});

test('the optimistic selection is visible while the command is pending and the selector cannot be used twice', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  let release;
  w.focusDelay = new Promise((r) => { release = r; });
  const first = selection.select(SESSION, 'w2');
  await settle();
  let s = ctx.state();
  assert.equal(selectedId(s), 'w2');
  assert.equal(s.pending.workspaceId, 'w2');
  assert.equal(s.canSelect, false);
  const second = await selection.select(SESSION, 'w3');
  assert.equal(second.ok, false);
  assert.equal(second.error.code, 'busy');
  assert.deepEqual(w.focusCalls, ['w2'], 'a concurrent request never reaches Herdr');
  release();
  assert.equal((await first).ok, true);
  s = ctx.state();
  assert.equal(s.pending, null);
  assert.equal(s.canSelect, true);
  assert.equal((await selection.select(SESSION, 'w3')).ok, true, 'selectable again afterwards');
  assert.deepEqual(w.focusCalls, ['w2', 'w3']);
  stop(ctx);
});

test('unknown workspace, wrong session and bad arguments are refused in main without touching Herdr', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  const before = JSON.stringify(ctx.state());
  const cases = [
    [SESSION, 'w99', 'workspace_not_found'],
    [SESSION, '', 'workspace_not_found'],
    [SESSION, null, 'workspace_not_found'],
    [SESSION, { id: 'w1' }, 'workspace_not_found'],
    ['another-session', 'w2', 'session_mismatch'],
    [null, 'w2', 'session_mismatch'],
    [undefined, 'w2', 'session_mismatch']
  ];
  for (const [session, id, code] of cases) {
    const r = await selection.select(session, id);
    assert.equal(r.ok, false);
    assert.equal(r.error.code, code, JSON.stringify([session, id]));
  }
  assert.deepEqual(w.focusCalls, []);
  assert.equal(JSON.stringify(ctx.state()), before, 'refusals leave the state untouched');
  stop(ctx);
});

test('focus failure reported by Herdr: selection reverts, error is kept, the list is refreshed, connection stays', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  w.focusError = Object.assign(new Error('workspace w2 not found'), { code: 'workspace_not_found' });
  w.requestLog.length = 0;
  const r = await selection.select(SESSION, 'w2');
  await settle();
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'workspace_not_found');
  const s = ctx.state();
  assert.equal(selectedId(s), 'w1', 'reverted to the previous selection');
  assert.equal(s.pending, null);
  assert.equal(s.lastError.code, 'workspace_not_found');
  assert.equal(s.connection, 'connected');
  assert.ok(w.requestLog.includes('session.snapshot'), 'a refresh follows a refused command');
  stop(ctx);
});

test('focus failure in manual mode restores the previous explicit choice (nothing else would mask a missing revert)', async () => {
  const ctx = await make({ mode: 'manual', last: { session: SESSION, workspaceId: 'w1' } });
  const { w, selection } = ctx;
  assert.equal(selectedId(ctx.state()), 'w1');
  w.focusError = Object.assign(new Error('workspace w2 not found'), { code: 'workspace_not_found' });
  const r = await selection.select(SESSION, 'w2');
  await settle();
  assert.equal(r.ok, false);
  assert.equal(selectedId(ctx.state()), 'w1');
  assert.equal(ctx.state().selected.origin, 'recovery', 'the previous selection object is restored as it was');
  assert.deepEqual(ctx.prefs.writes, [], 'a failed selection is not persisted');
  stop(ctx);
});

test('API timeout: the connection is treated as lost, the old command is never re-sent, recovery follows the observed focus', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  w.focusError = Object.assign(new Error('Herdr did not answer'), { code: 'timeout' });
  const r = await selection.select(SESSION, 'w3');
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'timeout');
  let s = ctx.state();
  assert.equal(s.connection, 'disconnected');
  assert.equal(s.pending, null);
  assert.equal(selectedId(s), 'w1', 'previous selection restored');
  assert.equal(s.canSelect, false);
  assert.equal((await selection.select(SESSION, 'w2')).error.code, 'not_connected');
  w.focusError = null;
  await w.advance(1000);                      // reconnect
  s = ctx.state();
  assert.equal(s.connection, 'connected');
  assert.deepEqual(w.focusCalls, ['w3'], 'the failed command was not replayed after reconnecting');
  assert.equal(selectedId(s), 'w1');
  assert.equal(s.selected.origin, 'recovery');
  stop(ctx);
});

test('focus changed in the TUI updates the selector in auto mode without sending any command', async () => {
  const ctx = await make();
  const { w } = ctx;
  w.tuiSwitch(2);
  await w.advance(2000);
  let s = ctx.state();
  assert.equal(selectedId(s), 'w2');
  assert.equal(s.selected.origin, 'herdr');
  assert.equal(s.observedId, 'w2');
  assert.equal(s.reliability, 'last_writer', 'an estimate, not an identification of our client');
  w.tuiSwitch(3);
  await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w3');
  assert.deepEqual(w.focusCalls, [], 'observing never sends workspace.focus');
  stop(ctx);
});

test('duplicate focus events cause one re-read and no state churn or commands', async () => {
  const ctx = await make();
  const { w } = ctx;
  w.tuiSwitch(2);
  await w.advance(2000);
  const reads = w.apis[0].requests;
  const origin = ctx.state().selected.at;
  for (let i = 0; i < 6; i++) w.apis[0].emit({ event: 'workspace_focused', data: { type: 'workspace_focused', workspace_id: 'w2' } });
  await w.advance(2000);
  assert.equal(w.apis[0].requests, reads + 1, 'six duplicates, one read');
  assert.equal(ctx.state().selected.at, origin, 'the selection object was not replaced by an identical one');
  assert.deepEqual(w.focusCalls, []);
  stop(ctx);
});

test('old and out-of-order events never win over the latest snapshot', async () => {
  const ctx = await make();
  const { w } = ctx;
  w.setSnapshot(THREE, 3);
  w.apis[0].emit({ event: 'workspace_focused', data: { workspace_id: 'w2' } });   // stale: says w2
  w.apis[0].emit({ event: 'workspace_focused', data: { workspace_id: 'w1' } });   // stale: says w1
  await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w3', 'state comes from the snapshot, not from event order');
  assert.deepEqual(w.focusCalls, []);
  stop(ctx);
});

test('a pending selection is never overwritten by a reconciliation that started before the command finished', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  let release;
  w.focusDelay = new Promise((r) => { release = r; });
  const op = selection.select(SESSION, 'w3');
  await settle();
  w.tuiSwitch(2);                      // someone moves focus while our command is in flight
  await w.advance(2000);               // an observer read happens during the pending phase
  const s = ctx.state();
  assert.equal(selectedId(s), 'w3', 'requested selection kept');
  assert.equal(s.observedId, 'w2', 'the observation is recorded separately');
  assert.ok(s.pending);
  release();
  const result = await op;
  assert.equal(result.ok, true);
  assert.equal(ctx.state().observedId, 'w3', 'our command ran last, a fresh snapshot confirms it');
  assert.equal(selectedId(ctx.state()), 'w3');
  stop(ctx);
});

test('someone else moves focus right after our command: auto follows, manual keeps the choice; neither re-sends', async () => {
  for (const mode of ['auto', 'manual']) {
    const ctx = await make({ mode });
    const { w, selection } = ctx;
    w.afterFocus = () => w.setSnapshot(THREE, 2);
    const r = await selection.select(SESSION, 'w3');
    assert.equal(r.ok, true, mode);
    assert.equal(r.confirmed, false, mode);
    assert.equal(r.observedId, 'w2', mode);
    assert.equal(selectedId(ctx.state()), mode === 'auto' ? 'w2' : 'w3', mode);
    assert.deepEqual(w.focusCalls, ['w3'], mode);
    stop(ctx);
  }
});

test('no synchronization loops: a long session of events, heartbeats and reconnects produces exactly the user-initiated commands', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  await selection.select(SESSION, 'w2');
  for (const n of [3, 1, 3, 2, 2, 1]) { w.tuiSwitch(n); await w.advance(1500); }
  await w.advance(10 * 60_000);                           // ten minutes of heartbeats
  w.liveApi().drop(new Error('pipe broke')); await settle();
  await w.advance(1000);                                  // reconnect
  w.tuiSwitch(3); await w.advance(2000);
  assert.deepEqual(w.focusCalls, ['w2'], 'only the explicit selection ever sent workspace.focus');
  assert.equal(selectedId(ctx.state()), 'w3');
  stop(ctx);
});

test('selecting what is already shown and observed is a no-op (no command), and becomes an explicit choice', async () => {
  const ctx = await make();
  const { w, selection, prefs } = ctx;
  assert.equal(ctx.state().selected.origin, 'recovery');
  const r = await selection.select(SESSION, 'w1');
  assert.deepEqual(r, { ok: true, noop: true, confirmed: true });
  assert.deepEqual(w.focusCalls, []);
  assert.equal(ctx.state().selected.origin, 'dock');
  assert.deepEqual(prefs.value.lastWorkspace, { session: SESSION, workspaceId: 'w1' });
  stop(ctx);
});

test('sync mode: manual ignores global focus events, auto follows; switching to auto adopts the observed focus without a command', async () => {
  const ctx = await make({ mode: 'manual' });
  const { w, selection, prefs } = ctx;
  assert.equal(ctx.state().mode, 'manual');
  assert.equal(selectedId(ctx.state()), null, 'manual with no saved choice waits for an explicit selection');
  await selection.select(SESSION, 'w2');
  w.tuiSwitch(3); await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w2', 'manual: the global event does not move the selector');
  assert.equal(ctx.state().observedId, 'w3');
  assert.deepEqual(selection.setMode('auto'), { ok: true, mode: 'auto' });
  assert.equal(selectedId(ctx.state()), 'w3');
  assert.deepEqual(prefs.value.mode, 'auto');
  w.tuiSwitch(1); await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w1');
  assert.equal(selection.setMode('manual').ok, true);
  w.tuiSwitch(2); await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w1', 'back in manual: stays put');
  assert.equal(selection.setMode('turbo').ok, false);
  assert.equal(selection.setMode(undefined).error.code, 'invalid_mode');
  assert.deepEqual(w.focusCalls, ['w2']);
  stop(ctx);
});

test('startup with persisted state never sends focus: manual restores the saved choice, auto follows the observed focus', async () => {
  const saved = { session: SESSION, workspaceId: 'w2' };
  const manual = await make({ mode: 'manual', last: saved, focused: 1 });
  assert.equal(selectedId(manual.state()), 'w2');
  assert.equal(manual.state().selected.origin, 'recovery');
  assert.equal(manual.state().observedId, 'w1');
  assert.deepEqual(manual.w.focusCalls, [], 'a persisted preference alone never moves Herdr');
  stop(manual);

  const auto = await make({ mode: 'auto', last: saved, focused: 1 });
  assert.equal(selectedId(auto.state()), 'w1');
  assert.equal(auto.state().selected.origin, 'recovery');
  assert.deepEqual(auto.w.focusCalls, []);
  assert.deepEqual(auto.prefs.value.lastWorkspace, saved, 'an inferred selection is not persisted over the explicit one');
  assert.deepEqual(auto.prefs.writes, [], 'nothing was written at startup');
  stop(auto);

  const foreign = await make({ mode: 'manual', last: { session: 'some-other-session', workspaceId: 'w2' } });
  assert.equal(selectedId(foreign.state()), null, 'a choice saved for another session is ignored');
  stop(foreign);
});

test('workspace removed: the selector reports it as unavailable and another one can be chosen', async () => {
  const ctx = await make({ mode: 'manual', last: { session: SESSION, workspaceId: 'w2' } });
  const { w, selection } = ctx;
  assert.equal(selectedId(ctx.state()), 'w2');
  w.setSnapshot([[1, 'api'], [3, 'docs']], 1);
  w.apis[0].emit({ event: 'workspace_closed', data: { workspace_id: 'w2' } });
  await w.advance(2000);
  let s = ctx.state();
  assert.equal(s.selected, null);
  assert.equal(s.unavailableId, 'w2');
  assert.deepEqual(s.options.map((o) => o.id), ['w1', 'w3']);
  assert.equal((await selection.select(SESSION, 'w2')).error.code, 'workspace_not_found');
  assert.equal((await selection.select(SESSION, 'w3')).ok, true);
  s = ctx.state();
  assert.equal(selectedId(s), 'w3');
  assert.equal(s.unavailableId, null);
  stop(ctx);

  const gone = await make({ mode: 'manual', last: { session: SESSION, workspaceId: 'w9' } });
  assert.equal(gone.state().unavailableId, 'w9', 'a saved workspace that no longer exists is flagged at startup');
  assert.equal(selectedId(gone.state()), null);
  assert.deepEqual(gone.w.focusCalls, []);
  stop(gone);
});

test('in auto mode a closed selected workspace is replaced by the observed focus', async () => {
  const ctx = await make();
  const { w } = ctx;
  w.tuiSwitch(2); await w.advance(2000);
  w.setSnapshot([[1, 'api'], [3, 'docs']], 1);
  w.apis[0].emit({ event: 'workspace_closed', data: { workspace_id: 'w2' } });
  await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w1');
  assert.equal(ctx.state().unavailableId, null);
  stop(ctx);
});

test('reconnection after a drop: preferences and list are kept, the list is reconciled, nothing is re-sent', async () => {
  const ctx = await make({ mode: 'manual', last: { session: SESSION, workspaceId: 'w2' } });
  const { w, selection } = ctx;
  w.setSnapshot([[1, 'api'], [2, 'web'], [3, 'docs'], [4, 'new']], 1);
  w.liveApi().drop(new Error('pipe broke'));
  await settle();
  let s = ctx.state();
  assert.equal(s.connection, 'disconnected');
  assert.equal(s.canSelect, false);
  assert.equal(selectedId(s), 'w2', 'local choice survives the outage');
  assert.deepEqual(s.options.map((o) => o.id), ['w1', 'w2', 'w3'], 'last known list is kept while disconnected');
  assert.equal((await selection.select(SESSION, 'w3')).error.code, 'not_connected');
  await w.advance(1000);
  s = ctx.state();
  assert.equal(s.connection, 'connected');
  assert.deepEqual(s.options.map((o) => o.id), ['w1', 'w2', 'w3', 'w4']);
  assert.equal(selectedId(s), 'w2');
  assert.deepEqual(w.focusCalls, []);
  stop(ctx);
});

test('renamed workspaces update the options; the selection keeps its id', async () => {
  const ctx = await make({ mode: 'manual', last: { session: SESSION, workspaceId: 'w2' } });
  const { w } = ctx;
  w.setSnapshot([[1, 'api'], [2, 'frontend'], [3, 'docs']], 1);
  w.apis[0].emit({ event: 'workspace_renamed', data: { workspace_id: 'w2', label: 'frontend' } });
  await w.advance(2000);
  const s = ctx.state();
  assert.deepEqual(s.options.map((o) => [o.id, o.label]), [['w1', 'api'], ['w2', 'frontend'], ['w3', 'docs']]);
  assert.equal(selectedId(s), 'w2');
  stop(ctx);
});

test('workspaces with the same name are told apart by id and the right one receives the focus', async () => {
  const ctx = await make({ workspaces: [[1, 'app'], [2, 'app'], [3, 'app']], focused: 1 });
  const { w, selection } = ctx;
  assert.deepEqual(ctx.state().options.map((o) => [o.id, o.label]), [['w1', 'app'], ['w2', 'app'], ['w3', 'app']]);
  assert.equal((await selection.select(SESSION, 'w2')).ok, true);
  assert.deepEqual(w.focusCalls, ['w2']);
  assert.equal(selectedId(ctx.state()), 'w2');
  w.tuiSwitch(3); await w.advance(2000);
  assert.equal(selectedId(ctx.state()), 'w3');
  stop(ctx);
});

test('stale operations are dropped: a command that finishes after the connection changed or after stop() changes nothing', async () => {
  const ctx = await make();
  const { w, selection } = ctx;
  let release;
  w.focusDelay = new Promise((r) => { release = r; });
  const op = selection.select(SESSION, 'w3');
  await settle();
  assert.ok(ctx.state().pending);
  w.liveApi().drop(new Error('pipe broke'));                // connection lost while the command is pending
  await settle();
  let s = ctx.state();
  assert.equal(s.pending, null, 'pending request invalidated by the connection change');
  assert.equal(selectedId(s), 'w1', 'selection shown again as before the request');
  assert.equal(s.lastError.code, 'connection_lost');
  release();                                                // the old command completes late
  const r = await op;
  assert.equal(r.ok, false);
  assert.equal(r.stale, true);
  await w.advance(1000);                                    // reconnect
  assert.deepEqual(w.focusCalls, ['w3'], 'never replayed');
  assert.equal(ctx.state().pending, null);

  // stop() while pending: the late completion is discarded and mutates nothing.
  let release2;
  w.focusDelay = new Promise((r) => { release2 = r; });
  const op2 = selection.select(SESSION, 'w2');
  await settle();
  selection.stop();
  const frozen = JSON.stringify(selection.getState().selected);
  release2();
  const r2 = await op2;
  assert.equal(r2.stale, true);
  assert.equal(JSON.stringify(selection.getState().selected), frozen);
  w.observer.stop();
});

test('selecting while the observer is disconnected or stopped fails cleanly', async () => {
  const w = world({ session: SESSION, workspaces: THREE, focused: 1 });
  const prefs = { value: { mode: 'auto', lastWorkspace: null }, get() { return this.value; }, set(p) { Object.assign(this.value, p); } };
  const selection = createWorkspaceSelection({ session: SESSION, observer: w.observer, preferences: prefs, now: w.now });
  selection.start();
  assert.equal((await selection.select(SESSION, 'w2')).error.code, 'not_connected');
  const s = selection.getState();
  assert.equal(s.connection, 'stopped');
  assert.deepEqual(s.options, []);
  assert.equal(s.canSelect, false);
  assert.deepEqual(w.focusCalls, []);
  selection.stop();
});

test('single workspace: reliability is certain, and stop() releases subscriptions', async () => {
  const ctx = await make({ workspaces: [[7, 'solo']], focused: 7 });
  assert.equal(ctx.state().reliability, 'only_workspace');
  assert.equal(selectedId(ctx.state()), 'w7');
  assert.deepEqual(ctx.selection._resources(), { listeners: 1, subscribed: true });
  const observerListenersBefore = ctx.w.observer._resources().listeners;
  stop(ctx);
  assert.deepEqual(ctx.selection._resources(), { listeners: 0, subscribed: false });
  assert.ok(observerListenersBefore >= 1);
  assert.equal(ctx.w.pendingTimers(), 0);
});
