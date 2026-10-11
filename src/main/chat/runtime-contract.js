'use strict';

// ChatRuntime: the TRANSIENT side of a conversation (M01-I3A contract, not yet a manager).
//
// A binding (src/main/chat-bindings) says which conversation belongs to which workspace and survives restarts.
// The runtime says what a loaded page is doing right now and never survives anything. They meet only through the
// binding id (future M01-I3B: one runtime per binding, one WebContentsView per runtime). This file is pure data
// with no Electron, no DOM detector and no persistence dependency; the persistence layer must not import it
// (pinned by test/structure.test.js).
//
//   PageLifecycle   unloaded | loading | ready | error | destroyed
//   GenerationState unknown | idle | responding | ended-unclassified | interrupted | completed | error
//   DraftState      unknown | empty | present
//   AttentionState  pending | acknowledged
//
// Every dimension is an Observation: { value, source, reliability, observedAt, validUntil }.
//   source       who produced it: 'navigation' (Electron events), 'dom-probe' (I3P boolean probe), 'user' (explicit
//                action), 'none' (nothing observed yet).
//   reliability  'observed' (read directly), 'inferred' (heuristic), 'unknown'.
//   validUntil   epoch ms after which the observation must be treated as stale, or null when it does not expire.
//                A stale observation reads as `unknown` (effectiveValue).
// `completed`, `interrupted` and `error` need a positive signal; `ended-unclassified` ("it stopped, we cannot say
// why") is never promoted to `completed` here.

const PageLifecycle = Object.freeze({ UNLOADED: 'unloaded', LOADING: 'loading', READY: 'ready', ERROR: 'error', DESTROYED: 'destroyed' });
const GenerationState = Object.freeze({
  UNKNOWN: 'unknown', IDLE: 'idle', RESPONDING: 'responding', ENDED_UNCLASSIFIED: 'ended-unclassified',
  INTERRUPTED: 'interrupted', COMPLETED: 'completed', ERROR: 'error'
});
const DraftState = Object.freeze({ UNKNOWN: 'unknown', EMPTY: 'empty', PRESENT: 'present' });
const AttentionState = Object.freeze({ PENDING: 'pending', ACKNOWLEDGED: 'acknowledged' });
const Reliability = Object.freeze({ OBSERVED: 'observed', INFERRED: 'inferred', UNKNOWN: 'unknown' });
const Source = Object.freeze({ NAVIGATION: 'navigation', DOM_PROBE: 'dom-probe', USER: 'user', NONE: 'none' });

// States that assert an outcome: they need a positive signal, so they are never produced from "nothing seen".
const OUTCOME_STATES = Object.freeze([GenerationState.COMPLETED, GenerationState.INTERRUPTED, GenerationState.ERROR]);

function observation(value, { source = Source.NONE, reliability = Reliability.UNKNOWN, observedAt = null, validUntil = null } = {}) {
  return Object.freeze({ value, source, reliability, observedAt, validUntil });
}

const isStale = (obs, now) => Boolean(obs && obs.validUntil !== null && now > obs.validUntil);
const effectiveValue = (obs, now, unknownValue = 'unknown') => (!obs || isStale(obs, now) ? unknownValue : obs.value);

function initialRuntime() {
  return Object.freeze({
    page: observation(PageLifecycle.UNLOADED, { source: Source.NAVIGATION, reliability: Reliability.OBSERVED }),
    generation: observation(GenerationState.UNKNOWN),
    draft: observation(DraftState.UNKNOWN),
    attention: observation(AttentionState.ACKNOWLEDGED)
  });
}

// Maps the I3P observer state (state-model.js) onto this contract. `ended-unclassified` was a `reason` of an
// `unknown` generation there; here it is a first-class value. `ttlMs` bounds how long a probe reading is trusted
// (default: three hidden-idle polls, see state-observer.js).
function fromObserverState(state, { now = Date.now(), ttlMs = 15000 } = {}) {
  const fromProbe = (value, evidence) => observation(value, {
    source: Source.DOM_PROBE,
    reliability: evidence === 'observed' ? Reliability.OBSERVED : evidence === 'inferred' ? Reliability.INFERRED : Reliability.UNKNOWN,
    observedAt: now,
    validUntil: now + ttlMs
  });
  let generation = state.generation.state;
  if (generation === 'unknown' && state.generation.reason === 'ended-unclassified') generation = GenerationState.ENDED_UNCLASSIFIED;
  const known = Object.values(GenerationState).includes(generation) ? generation : GenerationState.UNKNOWN;
  // An outcome claimed without evidence is downgraded rather than trusted.
  const unsupportedOutcome = OUTCOME_STATES.includes(known) && state.generation.evidence === 'unknown';
  return Object.freeze({
    page: observation(state.page, { source: Source.NAVIGATION, reliability: Reliability.OBSERVED, observedAt: now }),
    generation: unsupportedOutcome ? observation(GenerationState.UNKNOWN) : fromProbe(known, state.generation.evidence),
    draft: fromProbe(state.draft.state, state.draft.evidence),
    attention: observation(state.attention.pending ? AttentionState.PENDING : AttentionState.ACKNOWLEDGED, {
      source: state.attention.pending ? Source.DOM_PROBE : Source.USER,
      reliability: Reliability.INFERRED,
      observedAt: now
    })
  });
}

// The interface the future runtime manager (M01-I3B) implements. Nothing implements or calls it yet.
//   getRuntime(bindingId)  -> runtime | null   (null: that binding has no loaded page)
//   subscribe(listener)    -> unsubscribe       (listener(bindingId, runtime))
// A runtime is looked up BY binding id; a binding never stores or embeds a runtime.
const RUNTIME_PROVIDER_METHODS = Object.freeze(['getRuntime', 'subscribe']);

module.exports = {
  PageLifecycle, GenerationState, DraftState, AttentionState, Reliability, Source, OUTCOME_STATES, RUNTIME_PROVIDER_METHODS,
  observation, isStale, effectiveValue, initialRuntime, fromObserverState
};
