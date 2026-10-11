'use strict';

// Pure state model of one ChatGPT view (M01-I3P spike). Three independent dimensions, each with its own
// evidence level, plus the identity of the conversation the observation belongs to.
//
//   page        PageLifecycle    unloaded | loading | ready | error | destroyed
//   generation  GenerationState  unknown | idle | responding | completed | interrupted | error
//   draft       DraftState       unknown | empty | present
//
// Evidence: `observed` (a UI signal read directly), `inferred` (a heuristic over signals), `unknown`.
// Nothing here knows about Electron or about the content of a conversation; the reducer is deterministic
// and returns the SAME object when an event changes nothing, so callers can emit on reference inequality.

const PAGE = Object.freeze({ UNLOADED: 'unloaded', LOADING: 'loading', READY: 'ready', ERROR: 'error', DESTROYED: 'destroyed' });
const GEN = Object.freeze({ UNKNOWN: 'unknown', IDLE: 'idle', RESPONDING: 'responding', COMPLETED: 'completed', INTERRUPTED: 'interrupted', ERROR: 'error' });
const DRAFT = Object.freeze({ UNKNOWN: 'unknown', EMPTY: 'empty', PRESENT: 'present' });
const EVIDENCE = Object.freeze({ OBSERVED: 'observed', INFERRED: 'inferred', UNKNOWN: 'unknown' });

const ID_RE = /^[A-Za-z0-9-]{8,128}$/;
const UNKNOWN_IDENTITY = Object.freeze({ kind: 'unknown', key: 'unknown' });

// The identity comes only from the URL (never from titles or content). A "new" chat has no durable id yet.
function parseConversationIdentity(url) {
  let u;
  try { u = new URL(url); } catch { return UNKNOWN_IDENTITY; }
  if (u.protocol !== 'https:') return UNKNOWN_IDENTITY;
  if (u.hostname !== 'chatgpt.com') return { kind: 'other', key: 'other' };
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { kind: 'new', key: 'new' };
  if (parts.length === 2 && parts[0] === 'c' && ID_RE.test(parts[1])) return { kind: 'conversation', id: parts[1], key: `c:${parts[1]}` };
  if (parts.length === 4 && parts[0] === 'g' && parts[2] === 'c' && ID_RE.test(parts[1]) && ID_RE.test(parts[3])) {
    return { kind: 'project-conversation', project: parts[1], id: parts[3], key: `g:${parts[1]}/c:${parts[3]}` };
  }
  return { kind: 'other', key: 'other' };
}

const gen = (state, evidence, reason) => ({ state, evidence, reason });
const draft = (state, evidence) => ({ state, evidence });
const GEN_UNKNOWN = (reason) => gen(GEN.UNKNOWN, EVIDENCE.UNKNOWN, reason);
const DRAFT_UNKNOWN = draft(DRAFT.UNKNOWN, EVIDENCE.UNKNOWN);

function createState() {
  return {
    epoch: 0,
    page: PAGE.UNLOADED,
    identity: UNKNOWN_IDENTITY,
    generation: GEN_UNKNOWN('not-loaded'),
    draft: DRAFT_UNKNOWN,
    visible: false,
    attention: { pending: false },
    lastSeq: 0
  };
}

const isEnded = (g) => g.state === GEN.COMPLETED || g.state === GEN.INTERRUPTED || g.state === GEN.ERROR || g.reason === 'ended-unclassified';

// signals: { composer, stop, turnActions, error, interrupted } each true | false | null (null = not determinable)
function classifyGeneration(prev, s) {
  if (s.stop === true) return gen(GEN.RESPONDING, EVIDENCE.OBSERVED, 'stop-control');
  if (prev.state === GEN.RESPONDING) {
    // The stop control vanishing is NOT evidence of completion: it also happens on cancel, error and navigation.
    if (s.error === true) return gen(GEN.ERROR, EVIDENCE.INFERRED, 'error-signal-after-response');
    if (s.interrupted === true) return gen(GEN.INTERRUPTED, EVIDENCE.INFERRED, 'interrupt-notice');
    if (s.stop === false && s.composer === true) {
      return s.turnActions === true
        ? gen(GEN.COMPLETED, EVIDENCE.INFERRED, 'stop-gone+turn-actions')
        : GEN_UNKNOWN('ended-unclassified');
    }
    return GEN_UNKNOWN('signals-incomplete');
  }
  if (s.stop === null || s.composer === null) return GEN_UNKNOWN('signals-incomplete');
  if (s.stop === false && s.composer === true) {
    if (isEnded(prev)) return prev;                              // sticky until responding again or the identity changes
    return s.error === true ? gen(GEN.ERROR, EVIDENCE.INFERRED, 'error-signal') : gen(GEN.IDLE, EVIDENCE.INFERRED, 'composer-ready-no-stop');
  }
  return GEN_UNKNOWN('composer-missing');
}

function classifyDraft(s) {
  if (s.draft === true) return draft(DRAFT.PRESENT, EVIDENCE.OBSERVED);
  if (s.draft === false) return draft(DRAFT.EMPTY, EVIDENCE.OBSERVED);
  return DRAFT_UNKNOWN;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function withChanges(state, changes) {
  const next = { ...state, ...changes };
  for (const key of Object.keys(changes)) if (!sameJson(state[key], next[key])) return next;
  return state;
}

// Resets what was learned about the previous conversation: nothing is carried across identities.
function resetObservation(state, changes) {
  return { ...state, generation: GEN_UNKNOWN('identity-changed'), draft: DRAFT_UNKNOWN, attention: { pending: false }, ...changes };
}

function reduce(state, event) {
  if (state.page === PAGE.DESTROYED) return state;
  switch (event.type) {
    case 'page-loading':
      return { ...resetObservation(state, { page: PAGE.LOADING, identity: UNKNOWN_IDENTITY, generation: GEN_UNKNOWN('page-loading') }), epoch: state.epoch + 1 };
    case 'page-ready':
      return state.page === PAGE.LOADING ? { ...state, page: PAGE.READY } : state;
    case 'page-failed':
      return { ...state, epoch: state.epoch + 1, page: PAGE.ERROR, generation: GEN_UNKNOWN('page-error'), draft: DRAFT_UNKNOWN };
    case 'page-crashed':
      return { ...state, epoch: state.epoch + 1, page: PAGE.ERROR, generation: GEN_UNKNOWN('renderer-gone'), draft: DRAFT_UNKNOWN };
    case 'page-destroyed':
      return { ...state, epoch: state.epoch + 1, page: PAGE.DESTROYED, generation: GEN_UNKNOWN('destroyed'), draft: DRAFT_UNKNOWN, attention: { pending: false } };
    case 'navigated': {
      const identity = parseConversationIdentity(event.url);
      const durable = identity.kind === 'conversation' || identity.kind === 'project-conversation';
      if (durable && identity.key === state.identity.key) return state;
      // A brand-new chat gets its durable id when the first message is sent: same conversation, keep the response.
      const upgrade = event.inPage && state.identity.kind === 'new' && durable && state.generation.state === GEN.RESPONDING;
      if (upgrade) return { ...state, epoch: state.epoch + 1, identity, draft: DRAFT_UNKNOWN };
      if (!durable && identity.key === state.identity.key && identity.kind === state.identity.kind) return state;
      return { ...resetObservation(state, { identity }), epoch: state.epoch + 1 };
    }
    case 'signals': {
      if (state.page !== PAGE.READY || event.epoch !== state.epoch || !(event.seq > state.lastSeq)) return state;
      const s = event.signals;
      const generation = classifyGeneration(state.generation, s);
      const wasResponding = state.generation.state === GEN.RESPONDING;
      const ended = wasResponding && generation.state !== GEN.RESPONDING && isEnded(generation);
      const attention = ended && !state.visible ? { pending: true, reason: 'response-ended-in-background' } : state.attention;
      return { ...withChanges(state, { generation, draft: classifyDraft(s), attention }), lastSeq: event.seq };
    }
    case 'signals-lost': {
      if (state.page !== PAGE.READY || event.epoch !== state.epoch) return state;
      return withChanges(state, { generation: GEN_UNKNOWN('signal-lost'), draft: DRAFT_UNKNOWN });
    }
    case 'visibility':
      return withChanges(state, { visible: Boolean(event.visible) });
    case 'viewed':
      return withChanges(state, { attention: { pending: false } });
    default:
      return state;
  }
}

// Candidate lifecycle policy for M01-I3C. NOT wired to anything: it only answers "is it safe to even consider
// unloading this view?". Preserve unless every dimension is positively known to be quiet.
function lifecycleAdvice(state) {
  const preserve = [];
  if (state.page === PAGE.ERROR) preserve.push('page-error');
  else if (state.page !== PAGE.READY) preserve.push('page-not-ready');
  if (state.generation.state === GEN.RESPONDING) preserve.push('responding');
  else if (state.generation.state === GEN.UNKNOWN) preserve.push('generation-unknown');
  else if (state.generation.state === GEN.ERROR || state.generation.state === GEN.INTERRUPTED) preserve.push('needs-attention');
  if (state.draft.state === DRAFT.PRESENT) preserve.push('draft-present');
  else if (state.draft.state === DRAFT.UNKNOWN) preserve.push('draft-unknown');
  if (state.identity.kind !== 'conversation' && state.identity.kind !== 'project-conversation') preserve.push('identity-not-restorable');
  if (state.attention.pending) preserve.push('unviewed-response');
  if (state.visible) preserve.push('visible');
  return { evictable: preserve.length === 0, preserve };
}

module.exports = { PAGE, GEN, DRAFT, EVIDENCE, createState, reduce, parseConversationIdentity, lifecycleAdvice };
