'use strict';

const { fromObserverState, effectiveValue, GenerationState, DraftState, AttentionState } = require('../chat/runtime-contract');

// Observation hub (M01-I3B-2): one status observer per loaded ChatGPT view, built on the I3P detector and model
// (`createStateObserver`, unchanged), and the per-view summary the UI shows. Plain Node: the observer is created by
// an injected `startObserver`, so everything here is tested with fake observers.
//
// Rules:
//  - an observer follows the life of its view: created when the manager has the view, stopped when it is gone; the
//    same view is never observed twice; a view that is not loaded is simply absent (never reported "idle");
//  - observing never creates, loads, reloads, navigates, attaches or destroys a view, and never touches bindings or Herdr;
//  - nothing learned about one conversation is attributed to another: a summary is valid only while the identity the
//    observer saw equals the identity the manager shows for that view; otherwise it degrades to unknown;
//  - old readings expire (`ttlMs` after the last probe answer) instead of lingering as facts;
//  - UI updates happen only when a view's summary signature changes (no per-poll IPC); one shared sweep timer
//    (not one per view) lets expiry become visible.
//
// Attention (see docs/validation/m01-i3b-2.md): `pending` is set by the model when a response that was observed
// `responding` stops being observed while the view is NOT user-visible, and cleared only by a visit: an explicit user
// action that shows the view, the chat tab/window becoming interactive with the view on screen, or keyboard input in
// it. A visit means "the user could see it", not "the user read it".

const UNCERTAIN_REASONS = new Set(['end-unconfirmed', 'signals-unusable', 'busy-signal', 'stop-control-elsewhere']);

function createObservationHub({ manager, startObserver, now = () => Date.now(), setTimer = setTimeout, clearTimer = clearTimeout, ttlMs = 20000, sweepMs = 5000 }) {
  const entries = new Map();          // viewId -> { observer, visible, sig }
  const listeners = new Set();
  const attentionListeners = new Set();
  const presence = { interactive: false };   // window not minimized, shown and focused
  let sweepTimer;
  let stopped = false;

  const emit = () => { for (const l of [...listeners]) l(); };
  const phaseFor = (id) => 300 + ((Number(String(id).replace(/\D/g, '')) || 0) * 1700) % 4000;   // spread the first polls

  // The model keeps its own identity key (g:<project>/c:<id> for project routes); the manager's is c:<id>.
  const observerKey = (state) => (state.identity && state.identity.id ? `c:${String(state.identity.id).toLowerCase()}` : null);

  function summarize(id) {
    const entry = entries.get(id);
    const view = manager.get(id);
    if (!entry || !view || view.page === 'destroyed') return null;
    const state = entry.observer.getState();
    const stats = entry.observer.getStats();
    const identityOk = observerKey(state) === (view.identity.key || null);
    const observedAt = stats.lastPollAt;
    const runtime = fromObserverState(state, { now: now(), ttlMs, observedAt: observedAt === null ? now() : observedAt });
    const usable = state.page === 'ready' && identityOk && observedAt !== null;
    const generation = usable ? effectiveValue(runtime.generation, now(), GenerationState.UNKNOWN) : GenerationState.UNKNOWN;
    const draft = usable ? effectiveValue(runtime.draft, now(), DraftState.UNKNOWN) : DraftState.UNKNOWN;
    return {
      viewId: id,
      phase: state.page,
      identityKey: view.identity.key || null,
      identityOk,
      generation,
      generationReason: usable ? state.generation.reason || null : (identityOk ? null : 'identity-mismatch'),
      draft,
      attention: state.attention.pending ? AttentionState.PENDING : AttentionState.NONE,
      evidence: usable ? runtime.generation.reliability : 'unknown',
      stale: usable && generation === GenerationState.UNKNOWN && state.generation.state !== 'unknown',
      // A response believed to be in progress on thin evidence (M01-I3B-2R): the end is not confirmed, or the signals went quiet.
      uncertain: usable && generation === GenerationState.RESPONDING && UNCERTAIN_REASONS.has(state.generation.reason),
      observedAt
    };
  }

  const signature = (s) => (s ? JSON.stringify([s.phase, s.identityKey, s.identityOk, s.generation, s.generationReason, s.draft, s.attention, s.stale, s.uncertain]) : '');

  // Emits only when something the UI shows changed.
  // A NEW pending attention (none -> pending on a valid, ready view) is an event; a view that is already pending when first
  // summarized (startup, an observer restarted) is a baseline, not an event, and a state that merely stays pending never
  // repeats it. Reload, identity changes, lost probes and expiry reset attention in the model: they never produce one.
  function refresh(id) {
    const entry = entries.get(id);
    if (!entry) return;
    const summary = summarize(id);
    const pending = Boolean(summary && summary.attention === AttentionState.PENDING && summary.identityOk && summary.phase === 'ready');
    const fresh = entry.known && pending && !entry.pending;
    entry.known = true;
    entry.pending = pending;
    const sig = signature(summary);
    if (sig !== entry.sig) { entry.sig = sig; emit(); }
    if (fresh) for (const l of [...attentionListeners]) l({ viewId: id, identityKey: summary.identityKey });
  }

  const userVisible = (id) => presence.interactive && manager.isVisible(id);

  function recomputeVisibility() {
    for (const [id, entry] of entries) {
      const visible = userVisible(id);
      if (visible !== entry.visible) { entry.visible = visible; entry.observer.setVisible(visible); }
    }
  }

  function scheduleSweep() {
    if (stopped || sweepTimer || entries.size === 0) return;
    sweepTimer = setTimer(() => {
      sweepTimer = undefined;
      for (const id of [...entries.keys()]) refresh(id);       // lets an expired reading show as unknown
      scheduleSweep();
    }, sweepMs);
    sweepTimer.unref?.();
  }

  // Reconciles observers with the views that exist.
  function sync() {
    if (stopped) return;
    const alive = new Set(manager.list().map((v) => v.id));
    let changed = false;
    for (const id of alive) {
      if (entries.has(id)) continue;
      let observer = null;
      try { observer = startObserver({ viewId: id, handle: manager.handleOf(id), phaseMs: phaseFor(id), onChange: () => refresh(id) }); } catch { observer = null; }
      if (!observer) continue;                                  // observation disabled or not possible: the view just has no status
      entries.set(id, { observer, visible: false, sig: '', known: false, pending: false });
      changed = true;
    }
    for (const [id, entry] of [...entries]) {
      if (alive.has(id)) continue;
      try { entry.observer.stop(); } catch { /* Already gone. */ }
      entries.delete(id);
      changed = true;
    }
    recomputeVisibility();
    for (const id of entries.keys()) refresh(id);              // identity changes alter validity
    if (entries.size === 0 && sweepTimer) { clearTimer(sweepTimer); sweepTimer = undefined; }   // nothing left to sweep
    if (changed) { emit(); scheduleSweep(); }
  }

  const offManager = manager.onChange(sync);

  // The window tells whether the user can look at it (not minimized, shown, focused).
  function setInteractive(value) {
    const next = Boolean(value);
    if (next === presence.interactive) return;
    presence.interactive = next;
    recomputeVisibility();
  }

  // A visit: the view is on screen and the user can see it. Clears pending attention of that view only.
  function visit(id) {
    const entry = entries.get(id);
    if (!entry || !userVisible(id)) return false;
    if (entry.observer.getState().attention.pending) { entry.observer.markViewed(); refresh(id); }
    return true;
  }
  const visitVisible = () => (manager.getVisibleId() ? visit(manager.getVisibleId()) : false);

  function runtimeOf(id) {
    const entry = entries.get(id);
    const view = manager.get(id);
    if (!entry || !view) return null;
    const state = entry.observer.getState();
    const stats = entry.observer.getStats();
    return fromObserverState(state, { now: now(), ttlMs, observedAt: stats.lastPollAt === null ? now() : stats.lastPollAt });
  }

  sync();

  return {
    sync, setInteractive, visit, visitVisible, runtimeOf,
    summaryOf: summarize,
    isObserved: (id) => entries.has(id),
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    // New pending attention events (see refresh()).
    onAttention(listener) { attentionListeners.add(listener); return () => attentionListeners.delete(listener); },
    stats() {
      let polls = 0; let probeTimeouts = 0; let signalsLost = 0;
      for (const e of entries.values()) { const s = e.observer.getStats(); polls += s.polls; probeTimeouts += s.probeTimeouts || 0; signalsLost += s.signalsLost; }
      return { observers: entries.size, polls, probeTimeouts, signalsLost, sweepArmed: Boolean(sweepTimer) };
    },
    stop() {
      stopped = true;
      offManager();
      clearTimer(sweepTimer);
      sweepTimer = undefined;
      for (const entry of entries.values()) { try { entry.observer.stop(); } catch { /* Already gone. */ } }
      entries.clear();
      listeners.clear();
      attentionListeners.clear();
    }
  };
}

module.exports = { createObservationHub };
