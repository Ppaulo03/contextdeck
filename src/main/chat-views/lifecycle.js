'use strict';

// View lifecycle (M01-I3C-1, docs/decisions/0005-view-lifecycle.md): which ChatGPT pages could give their resources back, and the one
// explicit action that does it. Plain Node: it reads facts from the navigator, readings from the observation hub, and releases a page
// through manager.suspend(). It owns no timer, no pool and no eviction order; nothing here runs unless the user asked for it.
//
// Conceptual states (derived, never stored as a second source of truth):
//   created      a page that is loading for the first time           restoring    a page loading after a suspension
//   active       the page the user is looking at (selected)          background   a live page that is not the selected one
//   suspended    no page: a record in the manager (conversation key -> recovery address); the binding is untouched
//
// Principle: resources are released only when that cannot compromise the user's work. Every doubt blocks (a missing, stale, uncertain or
// unclassified reading is never evidence that a page is idle), and the decision is taken again, synchronously, from a reading
// requested for this very action, immediately before the page is released.

// Why a page cannot be suspended. Codes are a contract with src/shared/chat-nav-view.js (the texts shown to the user).
const { parseChatUrl } = require('../chat/conversation-identity');

const REASON = Object.freeze({
  SELECTED: 'selected', INITIAL: 'initial-page', TEMPORARY: 'temporary-page', NO_IDENTITY: 'no-recoverable-identity',
  NOT_READY: 'not-ready', NAVIGATING: 'navigating', IDENTITY: 'identity-unconfirmed', CREATING: 'creating', DECISION: 'pending-decision',
  CONFLICT: 'conflict', DUPLICATE: 'duplicate', SWITCHING: 'workspace-switching', BINDING: 'binding-unavailable', RECOVERY: 'recovery-url',
  UNOBSERVED: 'observation-unavailable', STALE: 'observation-stale', UNKNOWN: 'state-unknown', UNCERTAIN: 'uncertain',
  RESPONDING: 'responding', DRAFT: 'draft', DRAFT_UNKNOWN: 'draft-unknown', ATTENTION: 'attention', BUSY: 'operation-in-progress',
  UNSENT: 'unsent-content', UNSENT_UNKNOWN: 'unsent-unknown', RESIDUAL: 'residual-unbound', DESTROY: 'destroy-unconfirmed'
});

// Generations that mean "not producing an answer". `ended-unclassified` is in the list ONLY as a possible value: the other rules still apply.
const AT_REST = new Set(['idle', 'ended-unclassified', 'completed', 'interrupted', 'error']);

const fail = (code, message, extra) => ({ ok: false, error: { code, message, ...extra } });

// The pure rule. `facts` come from navigator.lifecycleFacts(); `notBefore` (optional) is the instant the reading must not predate.
// Returns every reason that applies (an empty list means eligible), in the order the user should hear about them.
function blockers(facts, { notBefore = null, busy = false, checkUnsent = true } = {}) {
  if (!facts) return [REASON.NOT_READY];
  const out = [];
  const add = (r) => { if (!out.includes(r)) out.push(r); };
  if (busy) add(REASON.BUSY);
  if (facts.kind === 'pristine') add(REASON.INITIAL);
  if (facts.kind === 'temporary') add(REASON.TEMPORARY);
  if (facts.selected) add(REASON.SELECTED);
  if (facts.switching) add(REASON.SWITCHING);
  if (facts.page === 'loading') add(REASON.NAVIGATING);
  else if (facts.page !== 'ready') add(REASON.NOT_READY);
  if (facts.creating) add(REASON.CREATING);
  if (facts.decision) add(REASON.DECISION);
  if (facts.conflict) add(REASON.CONFLICT);
  if (facts.duplicate) add(REASON.DUPLICATE);

  // Identity: the page must SHOW the conversation it stands for, and it must have shown it (an address that redirected away does not).
  if (facts.identity.state !== 'durable') add(facts.kind === 'binding' ? REASON.IDENTITY : REASON.NO_IDENTITY);
  else if (facts.kind === 'binding' && (facts.identity.key !== facts.expectedKey || !facts.reached || facts.relation !== 'match')) add(REASON.IDENTITY);
  if (facts.kind === 'binding' && facts.binding && (facts.binding.status === 'orphan' || facts.binding.status === 'other-session')) add(REASON.BINDING);
  if (facts.kind === 'residual') add(REASON.RESIDUAL);
  if (checkUnsent) {
    if (facts.unsentState === 'present') add(REASON.UNSENT);
    else if (facts.unsentState !== 'empty') add(REASON.UNSENT_UNKNOWN);
  }

  // Recovery: the address the page is rebuilt from must parse to the very conversation it shows.
  if (facts.identity.state === 'durable') {
    const parsed = parseChatUrl(facts.recoveryUrl);
    if (!parsed.ok || parsed.conversationKey !== facts.identity.key) add(REASON.RECOVERY);
  }

  // Observation: nothing is assumed about a page that is not (or no longer) being read.
  const s = facts.summary;
  if (!facts.observed || !s) { add(REASON.UNOBSERVED); return out; }
  if (!s.identityOk) add(REASON.IDENTITY);
  if (s.phase !== 'ready' || s.observedAt === null) add(REASON.UNOBSERVED);
  else if (notBefore !== null && s.observedAt < notBefore) add(REASON.STALE);
  if (s.stale) add(REASON.STALE);
  if (s.uncertain) add(REASON.UNCERTAIN);
  if (s.generation === 'responding') add(REASON.RESPONDING);
  // `ended-unclassified` carries no evidence by definition ("it stopped, we cannot say why"); it is accepted only because every other
  // reading below is fresh and clear. Every other generation must be backed by evidence.
  else if (!AT_REST.has(s.generation) || (s.generation !== 'ended-unclassified' && s.evidence === 'unknown')) add(REASON.UNKNOWN);
  if (s.draft === 'present') add(REASON.DRAFT);
  else if (s.draft !== 'empty') add(REASON.DRAFT_UNKNOWN);
  if (s.attention === 'pending') add(REASON.ATTENTION);
  return out;
}

// A probe that never answers is bounded by the observer itself (it then reports a lost signal, which blocks the suspension).
function createViewLifecycle({ manager, navigator, hub, now = () => Date.now(), clock = () => Number(process.hrtime.bigint()) / 1e6, onEvent = null }) {
  const inflight = new Set();          // view ids with a suspension under way
  let stopped = false;

  const emitEvent = (event) => { if (onEvent) { try { onEvent(event); } catch { /* Diagnostics never affect the lifecycle. */ } } };

  function stateOf(facts) {
    if (facts.page === 'loading') return facts.restored ? 'restoring' : 'created';
    return facts.selected ? 'active' : 'background';
  }

  // What the strip needs about one live page: its state, whether it can be suspended and, if not, why.
  function describe(viewId) {
    const facts = navigator.lifecycleFacts(viewId);
    if (!facts) return null;
    const reasons = blockers(facts, { busy: inflight.has(viewId) });
    return { state: stateOf(facts), kind: facts.kind, eligible: reasons.length === 0, reasons };
  }

  // Every managed page and every suspended conversation, with the answers the policy needs. A read, on demand: it never polls and never
  // asks a page anything.
  function inventory() {
    const rows = [];
    const suspendedRows = navigator.suspendedList();
    for (const v of manager.list()) {
      const facts = navigator.lifecycleFacts(v.id);
      if (!facts) continue;
      const s = facts.summary;
      const reasons = blockers(facts, { busy: inflight.has(v.id) });
      rows.push({
        viewId: v.id, state: stateOf(facts), kind: facts.kind, scope: facts.scope, selected: facts.selected, attached: v.attached,
        bindingId: facts.binding ? facts.binding.bindingId : null, hasBinding: Boolean(facts.binding),
        stableUrl: Boolean(facts.recoveryUrl), identity: facts.identity.state, page: facts.page,
        observed: facts.observed, responding: s ? s.generation === 'responding' : null,
        draft: s ? s.draft : null, attention: s ? s.attention === 'pending' : null,
        uncertain: s ? s.uncertain === true : null, navigating: facts.page === 'loading',
        conflict: facts.conflict, duplicate: facts.duplicate,
        restoreMs: facts.restoreMs,
        eligible: reasons.length === 0, blockers: reasons
      });
    }
    for (const r of suspendedRows) {
      rows.push({
        viewId: r.viewId, state: 'suspended', kind: r.kind, scope: r.scope, selected: false, attached: false,
        bindingId: r.bindingId, hasBinding: Boolean(r.bindingId), stableUrl: true, identity: 'durable', page: 'none',
        observed: false, responding: null, draft: null, attention: null, uncertain: null, navigating: false, conflict: false, duplicate: false,
        restoreMs: null, eligible: false, blockers: ['suspended']
      });
    }
    return rows;
  }

  // What the bindings panel needs: for every binding with a page or a suspension, its state and (for a live page) why it cannot be
  // suspended. A binding that was never opened has no entry (it has no page and it is not "idle").
  function byBinding() {
    const out = {};
    for (const r of inventory()) if (r.bindingId) out[r.bindingId] = r.state === 'suspended' ? { state: 'suspended', eligible: false, reasons: [] } : { state: r.state, eligible: r.eligible, reasons: r.blockers };
    return out;
  }

  function summary() {
    const rows = inventory();
    const live = rows.filter((r) => r.state !== 'suspended');
    return {
      created: live.length,
      selected: live.filter((r) => r.selected).length,
      hidden: live.filter((r) => !r.selected).length,
      residual: live.filter((r) => r.kind === 'residual').length,
      observed: live.filter((r) => r.observed).length,
      suspended: rows.length - live.length,
      eligible: live.filter((r) => r.eligible).length,
      // Pages the policy cannot recover (no durable identity): kept as they are, reported here instead of being discarded.
      unrecoverable: live.filter((r) => r.blockers.includes(REASON.NO_IDENTITY)).length
    };
  }

  // The explicit action. Target: `viewId` (a live page), found by the caller from the tab the user acted on.
  // 1. judge from the current state (cheap refusal), 2. ask the page for ONE fresh reading, 3. judge again, synchronously, from that
  // reading, 4. release. Everything that could change between 1 and 3 (a draft, an answer starting, the user selecting the page,
  // the workspace changing, the window closing) is read again in 3.
  async function suspend({ viewId } = {}) {
    if (stopped || manager.isClosed()) return fail('shutting_down', 'O aplicativo esta encerrando.');
    if (typeof viewId !== 'string' || !manager.get(viewId)) return fail('view_not_found', 'Esta conversa nao esta carregada.');
    if (inflight.has(viewId)) return fail('busy', 'Ja existe uma suspensao em andamento para esta conversa.', { reasons: [REASON.BUSY] });
    inflight.add(viewId);
    const t0 = clock();
    try {
      const initialFacts = navigator.lifecycleFacts(viewId);
      let reasons = blockers(initialFacts, { checkUnsent: false });
      if (initialFacts && initialFacts.unsentState === 'present') reasons.push(REASON.UNSENT);
      if (reasons.length) return refused(viewId, reasons);
      const asked = now();
      if (hub) await hub.probeNow(viewId); // a rejected/stale result is caught by the fresh summary below
      const handle = manager.handleOf(viewId);
      let unsent = 'unknown';
      try { if (handle && typeof handle.unsentState === 'function') unsent = await handle.unsentState(); } catch { /* A failed page probe is inconclusive. */ }
      if (stopped || manager.isClosed()) return fail('shutting_down', 'O aplicativo esta encerrando.');
      const t1 = clock();
      // From here to manager.suspend() nothing is awaited: what is judged is what is released.
      const facts = navigator.lifecycleFacts(viewId);
      reasons = blockers(facts, { notBefore: asked, checkUnsent: false });
      if (unsent === 'present') reasons.push(REASON.UNSENT);
      else if (unsent !== 'empty') reasons.push(REASON.UNSENT_UNKNOWN);
      if (reasons.length) return refused(viewId, reasons);
      const r = await manager.suspend(viewId, { url: facts.recoveryUrl });
      const t2 = clock();
      if (!r.ok) return refused(viewId, [r.code === 'selected' ? REASON.SELECTED : REASON.DESTROY]);
      const result = { ok: true, viewId, key: r.record.key, kind: facts.kind, bindingId: facts.binding ? facts.binding.bindingId : null, timings: { judgeMs: round(t1 - t0), releaseMs: round(t2 - t1) } };
      emitEvent({ type: 'suspended', ...result, at: now() });
      return result;
    } finally {
      inflight.delete(viewId);
    }
  }

  function refused(viewId, reasons) {
    emitEvent({ type: 'refused', viewId, reasons, at: now() });
    return fail('not_eligible', 'Esta conversa nao pode ser suspensa agora.', { reasons });
  }

  // A page that came back after a suspension reports how long it took to be ready (once).
  const reported = new Set();
  const offManager = manager.onChange(() => {
    const live = new Set(manager.list().map((v) => v.id));
    for (const id of reported) if (!live.has(id)) reported.delete(id);
    for (const v of manager.list()) {
      if (v.restored && v.restoreMs !== null && !reported.has(v.id)) {
        reported.add(v.id);
        emitEvent({ type: 'restored', viewId: v.id, restoreMs: v.restoreMs, at: now() });
      }
    }
  });

  return {
    describe, inventory, summary, byBinding, suspend,
    isBusy: (viewId) => inflight.has(viewId),
    stop() { stopped = true; offManager(); inflight.clear(); reported.clear(); }
  };
}

const round = (n) => Math.round(n * 100) / 100;

module.exports = { createViewLifecycle, blockers, REASON, AT_REST };
