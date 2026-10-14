'use strict';

const { REL } = require('./manager');
const { RUNTIME_PROVIDER_METHODS } = require('../chat/runtime-contract');

// Decides WHICH ChatGPT view is on screen for the selected workspace (M01-I3B-1) and drives the manager.
// Plain Node. It reads the I3A bindings and the workspace selection; it never writes bindings, never sends a
// Herdr command and never navigates an existing page. Its only persisted output is the last conversation the
// user explicitly chose per workspace (`prefs`, kept in ui-state.json, separate from the bindings file).
//
// The rule that matters (context safety): a view is shown only under the workspace it is scoped to. When the
// selected workspace changes, a view scoped to another workspace is detached SYNCHRONOUSLY, before anything
// asynchronous (loading the new conversation) can happen, so a late completion can never bring back a chat of
// the previous workspace. Everything is derived from the current state on each reconcile(); there are no timers.
//
// Automatic choices (restoring the last conversation, startup) only ever use a binding whose workspace status is
// `linked`. A `suspect` or `unverified` binding opens only after an explicit confirmation by the user; an orphan
// or foreign-session binding never opens (it is not part of any workspace's list).

const wsKeyOf = (b) => `${b.workspaceIdentity.session}/${b.workspaceIdentity.workspaceId}`;
const fail = (code, message, extra) => ({ ok: false, error: { code, message, ...extra } });

// `activity` (optional, the observation hub): per-view status (responding / draft / attention) shown on tabs and
// aggregated per workspace. It is read-only here: the navigator never starts, stops or feeds an observer, and an
// explicit user action that shows a view is reported as a visit (which acknowledges that view's pending attention).
function createChatNavigator({ manager, session, bindings, selection, prefs, homeUrl, activity = null, onAttention = null }) {
  const listeners = new Set();
  let mode = 'terminal';
  let reconciling = false;
  let again = false;
  const choice = new Map();          // workspace key -> id of a temporary view the user picked there
  let notes = null;                  // optional (viewId) -> text: why a page in a workspace is not bound yet (set by the adoption service)
  let lifecycle = null;              // optional (set by setLifecycle): describe(viewId) -> what the user may do about a page's resources

  const selectedWorkspace = () => {
    const sel = selection.getState();
    return { id: sel.selected ? sel.selected.workspaceId : null, origin: sel.selected ? sel.selected.origin : null, pending: Boolean(sel.pending), options: sel.options || [] };
  };
  const keyFor = (id) => (id ? `${session}/${id}` : null);
  const mine = (all) => all.filter((b) => b.workspaceIdentity.session === session);

  // Views follow their bindings: a view whose binding disappeared becomes temporary; one whose binding moved to
  // another workspace follows it only while it still shows that conversation; a temporary view that shows a
  // conversation bound in its own scope becomes that binding's view. Never touches a page.
  function syncViews(all) {
    const byKey = new Map(all.map((b) => [b.conversationKey, b]));
    const views = manager.list();
    // A conversation that has a view again (restored, or shown by another page) is not suspended any more; per-view bookkeeping of
    // views that no longer exist (released by a suspension) goes with them.
    for (const rec of manager.suspendedList()) if (manager.findByKey(rec.key)) manager.dropSuspended(rec.key);
    const live = new Set(views.map((v) => v.id));
    for (const id of [...contextual.keys()]) if (!live.has(id)) contextual.delete(id);
    for (const id of [...busyMemo.keys()]) if (!live.has(id)) busyMemo.delete(id);
    for (const [wk, id] of [...choice]) if (!live.has(id)) choice.delete(wk);
    for (const v of views) {
      if (v.expectedKey) {
        const b = byKey.get(v.expectedKey);
        if (!b) manager.setExpected(v.id, null);
        else if (v.scope !== wsKeyOf(b)) {
          if (v.relation === REL.MATCH || v.relation === REL.LOADING) manager.setScope(v.id, wsKeyOf(b));
          else manager.setExpected(v.id, null);
        }
      } else if (v.identity.state === 'durable') {
        const b = byKey.get(v.identity.key);
        // A conversation bound later (or by navigating to a bound one) leaves the exceptional unscoped list with its view intact.
        // (unless another page already is that conversation's tab: then this one stays out, never a second tab)
        if (b && b.status === 'linked' && v.scope === null) { if (!views.some((x) => x.id !== v.id && x.expectedKey === v.identity.key)) { manager.setScope(v.id, wsKeyOf(b)); manager.setExpected(v.id, v.identity.key); } }
        else if (b && b.status === 'linked' && v.scope !== null && wsKeyOf(b) === v.scope && !manager.list().some((x) => x.id !== v.id && x.expectedKey === v.identity.key)) manager.setExpected(v.id, v.identity.key);
      }
    }
  }

  // The view that serves binding `b`, reusing whatever already shows that conversation. Creates one only when
  // `allowCreate` (chat tab showing, no workspace switch in flight). Never reloads or navigates an existing view.
  function viewFor(b, allowCreate) {
    const key = b.conversationKey;
    const wk = wsKeyOf(b);
    const shown = manager.findByKey(key);
    if (shown) { manager.setScope(shown.id, wk); manager.setExpected(shown.id, key); return shown.id; }
    const loading = manager.findLoadingFor(key) || manager.findNeverReached(key);
    if (loading) { manager.setScope(loading.id, wk); return loading.id; }
    // A view opened for this conversation that has since left it keeps its page as a temporary view.
    for (const v of manager.list()) if (v.expectedKey === key) manager.setExpected(v.id, null);
    if (!allowCreate) return null;
    return manager.create({ url: b.url, scope: wk, expectedKey: key });
  }

  function chooseAutomatically(all, wk, allowCreate) {
    const picked = choice.get(wk);
    if (picked) {
      const v = manager.get(picked);
      if (v && v.scope === wk && v.page !== 'destroyed') return manager.show(picked);
      choice.delete(wk);
    }
    const last = prefs.getLast(wk);
    const b = last ? all.find((x) => x.bindingId === last && wsKeyOf(x) === wk) : null;
    if (b && b.status === 'linked') {
      const id = viewFor(b, allowCreate);
      if (id) return manager.show(id);
    }
    manager.hide();
    return false;
  }

  function reconcile() {
    if (reconciling) { again = true; return; }
    reconciling = true;
    try {
      do {
        again = false;
        const sel = selectedWorkspace();
        const all = mine(bindings.all());
        syncViews(all);
        const wk = keyFor(sel.id);
        const visibleId = manager.getVisibleId();
        const visible = visibleId ? manager.get(visibleId) : null;
        if (!wk) {
          // No workspace to scope to (Herdr not connected / nothing selected): the M00 behaviour, the unscoped page.
          if (!visible || visible.scope !== null) {
            const unscoped = manager.list().find((v) => v.scope === null);
            if (unscoped) manager.show(unscoped.id); else manager.hide();
          }
        } else if (!visible || visible.scope !== wk) {
          chooseAutomatically(all, wk, mode === 'chat' && !sel.pending);
        }
      } while (again);
    } finally { reconciling = false; }
    emit();
  }

  const emit = () => { const s = getState(); for (const l of [...listeners]) l(s); };

  // ---- explicit user actions -----------------------------------------------------------------------------------
  function guard(workspaceKey) {
    const sel = selectedWorkspace();
    if (mode !== 'chat') return fail('not_in_chat', 'A aba ChatGPT nao esta ativa.');
    if (!sel.id) return fail('no_workspace', 'Nenhum workspace selecionado.');
    if (sel.pending) return fail('selection_pending', 'Uma troca de workspace esta em andamento.');
    if (workspaceKey !== keyFor(sel.id)) return fail('context_changed', 'O workspace selecionado mudou. Revise a escolha.', { selected: sel.id });
    return { ok: true, wk: keyFor(sel.id) };
  }

  function selectBinding({ bindingId, workspaceKey, confirm } = {}) {
    const g = guard(workspaceKey);
    if (!g.ok) return g;
    const all = mine(bindings.all());
    const b = all.find((x) => x.bindingId === bindingId);
    if (!b) return fail('binding_not_found', 'Vinculo nao encontrado.');
    if (wsKeyOf(b) !== g.wk) return fail('not_in_workspace', 'Esta conversa pertence a outro workspace.');
    if (b.status === 'orphan' || b.status === 'other-session') return fail('not_available', 'Esta conversa nao esta disponivel.');
    if (b.status !== 'linked' && confirm !== true) return fail('confirmation_required', b.status === 'suspect' ? 'A identidade deste workspace nao foi verificada. Confirme para abrir.' : 'O Herdr esta desconectado e o workspace nao pode ser verificado. Confirme para abrir.', { status: b.status });
    syncViews(all);
    const id = viewFor(b, true);
    if (!id) return fail('open_failed', 'Nao foi possivel abrir a conversa.');
    const entry = manager.get(id);
    if (entry && entry.suspending) return fail('suspending', 'Esta conversa está sendo suspensa. Aguarde a confirmação.');
    if (entry && entry.page === 'error') manager.reloadFailed(id, b.url);
    choice.delete(g.wk);
    manager.show(id);
    prefs.setLast(g.wk, b.bindingId);
    reconcile();
    activity?.visit(id);
    return { ok: true, viewId: id };
  }

  // A new, unbound conversation under the selected workspace. The application's initial (never shown) page is
  // handed over without navigating it; otherwise a fresh page is created. Nothing is bound.
  // `entryUrl` (only ever supplied by main from a validated Project binding, never by the renderer) is the page the new
  // conversation starts on; with it the initial page is not reused (an existing page is never navigated).
  function newConversation({ workspaceKey, entryUrl } = {}) {
    const g = guard(workspaceKey);
    if (!g.ok) return g;
    // A second click while the first page is still waiting for its conversation shows that page: no second view.
    const waiting = manager.list().find((v) => v.scope === g.wk && (contextual.get(v.id) || {}).pending && v.identity.state !== 'durable' && v.page !== 'destroyed');
    const pristine = waiting || entryUrl ? null : manager.list().find((v) => v.scope === null && v.pristine && v.relation === REL.TEMPORARY);
    let id;
    if (waiting) id = waiting.id;
    else if (pristine) { manager.setScope(pristine.id, g.wk); id = pristine.id; }
    else id = manager.create({ url: entryUrl || homeUrl, scope: g.wk });
    if (!id) return fail('open_failed', 'Nao foi possivel abrir uma nova conversa.');
    contextual.set(id, { pending: true });
    choice.set(g.wk, id);
    manager.show(id);
    reconcile();
    activity?.visit(id);
    return { ok: true, viewId: id };
  }

  function selectTemporary({ viewId, workspaceKey } = {}) {
    const g = guard(workspaceKey);
    if (!g.ok) return g;
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.scope !== g.wk || v.page === 'destroyed') return fail('view_not_found', 'Conversa temporaria nao encontrada.');
    choice.set(g.wk, v.id);
    manager.show(v.id);
    reconcile();
    activity?.visit(v.id);
    return { ok: true, viewId: v.id };
  }

  // The unscoped page, only when there is no workspace to scope to.
  function openUnscoped() {
    if (mode !== 'chat') return fail('not_in_chat', 'A aba ChatGPT nao esta ativa.');
    if (selectedWorkspace().id) return fail('workspace_selected', 'Ha um workspace selecionado.');
    const existing = manager.list().find((v) => v.scope === null);
    const id = existing ? existing.id : manager.create({ url: homeUrl, scope: null });
    manager.show(id);
    reconcile();
    activity?.visit(id);
    return { ok: true, viewId: id };
  }

  // ---- workspace-first context (M01-I3B-3) -----------------------------------------------------------------------------------
  // A page that lives under a workspace (scope) was opened IN that workspace's context by the user. The navigator only keeps
  // the facts (which views are contextual, whether the user started a creation there that has not got its id yet); the
  // association itself is decided and written by activity/context-adoption.js through the chat bindings service, never here.
  //   pending  the user clicked "Nova conversa" in this workspace and the page has not shown a conversation id yet: when it
  //            does, it belongs to THAT workspace even if another one is selected by then.
  const contextual = new Map();       // viewId -> { pending }

  function contextViews() {
    const visibleId = manager.getVisibleId();
    return manager.list().filter((v) => v.scope !== null).map((v) => ({
      viewId: v.id,
      workspaceId: wsIdOf(v.scope),
      scope: v.scope,
      identity: { ...v.identity },
      expectedKey: v.expectedKey,
      relation: v.relation,
      visible: v.id === visibleId && manager.isAttached(),
      pending: Boolean((contextual.get(v.id) || {}).pending)
    }));
  }

  // The adoption (or an existing binding of the same workspace) made this page the view of that conversation.
  function confirmAdopted(viewId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.page === 'destroyed' || v.identity.state !== 'durable') return false;
    manager.setExpected(v.id, v.identity.key);
    const c = contextual.get(v.id);
    if (c) c.pending = false;
    return true;
  }

  // The user opened, inside page `viewId`, a conversation that already has its tab (`otherId`) here: show that tab and send this
  // page back to what it showed (its own history); a page with nothing to go back to leaves the workspace (kept, unscoped).
  // A page with an unsent draft or an answer in progress is never navigated away by the app (going back in history would drop what is
  // in it): it is kept as it is and moved instead.
  // The reading of a page is dropped when its address changes (it was about another conversation), so what it said just BEFORE the
  // navigation is remembered: that is the moment the question "is there something to lose here?" is asked.
  const busyMemo = new Map();
  function rememberBusy() {
    for (const v of manager.list()) { const a = activityOf(v); if (a) busyMemo.set(v.id, Boolean(a.draft || a.responding)); }
  }
  const isBusy = (viewId) => {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    const a = v ? activityOf(v) : null;
    return a ? Boolean(a.draft || a.responding) : Boolean(busyMemo.get(viewId));
  };

  function focusExisting(viewId, otherId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    const other = typeof otherId === 'string' ? manager.get(otherId) : null;
    if (!v || !other || v.page === 'destroyed' || other.page === 'destroyed' || !other.scope) return false;
    choice.set(other.scope, other.id);
    manager.show(other.id);
    if (isBusy(v.id) || !(manager.canGoBack(v.id) && manager.goBack(v.id))) releasePage(v.id);
    reconcile();
    activity?.visit(other.id);
    return true;
  }

  // The pages that show one conversation (durable identity), and the moves the transfer needs on them.
  const pagesShowing = (key) => manager.list().filter((v) => v.identity.state === 'durable' && v.identity.key === key).map((v) => ({ viewId: v.id, scope: v.scope }));
  function releasePage(viewId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.page === 'destroyed') return false;
    if (v.scope) choice.delete(v.scope);
    manager.setExpected(v.id, null);
    manager.setScope(v.id, null);
    contextual.delete(v.id);
    return true;
  }

  // "Voltar" on a conflict. If the page itself came from another conversation of this workspace (the user clicked the sidebar
  // inside it), going back in ITS history returns to that conversation: it is still the same page and tab. Otherwise the page
  // moves to its own workspace and the last active page of this one comes back.
  function backFromConflict(viewId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.page === 'destroyed') return fail('view_not_found', 'Conversa nao encontrada.');
    const hasPrevious = manager.list().some((x) => x.scope === v.scope && x.id !== v.id && x.lastShownAt > 0);
    // 1. the page was a conversation's tab and navigated away (expectedKey): its own history leads back to that conversation;
    // 2. otherwise the last other active page of this workspace; 3. a page with nothing else to return to goes back in history.
    // A conversation that belongs to nobody (the outside-Project question): the page goes back in its own history, wherever it came
    // from (the Project page, a conversation); with no history it leaves the workspace and the last active page comes back.
    const bound = v.identity.state === 'durable' && mine(bindings.all()).some((b) => b.conversationKey === v.identity.key);
    if (!bound) {
      if (!isBusy(v.id) && manager.canGoBack(v.id) && manager.goBack(v.id)) return { ok: true, viewId: v.id, how: 'history' };
      const previousPage = manager.list().filter((x) => x.scope === v.scope && x.id !== v.id && x.lastShownAt > 0).sort((p, q) => q.lastShownAt - p.lastShownAt)[0];
      if (previousPage) choice.set(v.scope, previousPage.id); else choice.delete(v.scope);
      releasePage(v.id);
      reconcile();
      return { ok: true, viewId: v.id, how: 'released' };
    }
    if ((v.expectedKey || !hasPrevious) && !isBusy(v.id) && manager.canGoBack(v.id) && manager.goBack(v.id)) return { ok: true, viewId: v.id, how: 'history' };
    return moveToBinding(viewId);
  }

  // Variant kept for the case without history: "Voltar" on a conflict: the page keeps its view but moves to the workspace the conversation belongs to; what the user was
  // doing in this workspace comes back. Nothing is rebound.
  function moveToBinding(viewId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.page === 'destroyed' || v.identity.state !== 'durable') return fail('view_not_found', 'Conversa nao encontrada.');
    const b = mine(bindings.all()).find((x) => x.conversationKey === v.identity.key);
    if (!b) return fail('not_bound', 'Esta conversa nao tem vinculo.');
    const from = v.scope;
    // Back to the page that was active in this workspace before the conflicting one (the most recently shown other page).
    const previous = manager.list().filter((x) => x.scope === from && x.id !== v.id && x.lastShownAt > 0).sort((p, q) => q.lastShownAt - p.lastShownAt)[0];
    manager.setScope(v.id, wsKeyOf(b));
    manager.setExpected(v.id, v.identity.key);
    contextual.delete(v.id);
    if (previous) choice.set(from, previous.id); else choice.delete(from);
    reconcile();
    return { ok: true, viewId: v.id };
  }

  // The user unbound a conversation: its page leaves the workspace (no tab, nothing shown there) but is NOT destroyed - a draft,
  // a running answer or its attention may still be in it, and views are only ever closed at shutdown. It becomes an unscoped
  // page, reachable from the exceptional list, and is bound again only if the user opens it in a workspace.
  function releaseConversation(key) {
    let released = 0;
    for (const v of manager.list()) {
      if (v.scope === null || v.identity.state !== 'durable' || v.identity.key !== key) continue;
      choice.delete(v.scope);
      manager.setExpected(v.id, null);
      manager.setScope(v.id, null);
      contextual.delete(v.id);
      released += 1;
    }
    if (released) reconcile();
    return released;
  }

  // ---- pages without a workspace (exceptional) -----------------------------------------------------------------------------
  // Only pages opened while NO workspace was selected (the application's M00 behaviour) or left over from before. They are not
  // a category of the interface: they are listed (and only when there are some) so that nothing becomes unreachable. Opening
  // one while a workspace is selected puts it in that workspace's context (the user's explicit action), where the normal
  // rules decide its binding.
  const unboundViews = () => manager.list().filter((v) => v.scope === null && !v.pristine);
  const unboundView = (viewId) => {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    return v && v.scope === null && v.page !== 'destroyed' && !v.pristine ? v : null;
  };

  // Suspended conversations nobody has a binding for: the unscoped pages that were released. (A bound one stays a tab of its workspace.)
  const suspendedResiduals = () => {
    const bound = new Set(mine(bindings.all()).map((b) => b.conversationKey));
    return manager.suspendedList().filter((r) => !bound.has(r.key));
  };
  const suspendedResidual = (viewId) => (typeof viewId === 'string' ? suspendedResiduals().find((r) => r.id === viewId) || null : null);

  function getUnbound() {
    const duplicated = new Set(manager.duplicates().flatMap((d) => d.viewIds));
    const visibleId = manager.getVisibleId();
    const released = suspendedResiduals().map((r) => ({
      viewId: r.id, label: 'Conversa', hint: r.key.slice(-4), identity: 'durable',
      responding: false, attention: false, draft: false, loading: false, failed: false, duplicate: false, active: false, suspended: true
    }));
    return [...unboundViews().map((v) => {
      const a = activityOf(v);
      const durable = v.identity.state === 'durable';
      return {
        viewId: v.id,
        label: durable ? 'Conversa' : 'Nova conversa',
        hint: durable ? v.identity.key.slice(-4) : '#' + v.id.slice(1),
        identity: v.identity.state,
        responding: Boolean(a && a.responding), attention: Boolean(a && a.attention), draft: Boolean(a && a.draft),
        loading: v.page === 'loading', failed: v.page === 'error',
        duplicate: duplicated.has(v.id),
        active: v.id === visibleId && manager.isAttached(),
        suspended: false,
        lifecycle: lifecycle ? lifecycle.describe(v.id) : null
      };
    }), ...released];
  }

  function openUnbound({ viewId } = {}) {
    if (mode !== 'chat') return fail('not_in_chat', 'A aba ChatGPT nao esta ativa.');
    const sel = selectedWorkspace();
    // A suspended page has no view: opening it brings it back (a fresh page on the same session, on its recovery address) and then
    // follows the normal path below. A second request finds the page already loading (the record is consumed by create()).
    const record = suspendedResidual(viewId);
    if (record && sel.pending) return fail('selection_pending', 'Uma troca de workspace esta em andamento.');
    if (record) { const back = manager.create({ url: record.url, scope: null }); if (!back) return fail('open_failed', 'Nao foi possivel restaurar a conversa.'); viewId = back; }
    const v = unboundView(viewId);
    if (!v) return fail('view_not_found', 'Esta conversa nao existe mais ou ja pertence a um workspace.');
    if (sel.pending) return fail('selection_pending', 'Uma troca de workspace esta em andamento.');
    if (v.page === 'error') manager.reloadFailed(v.id, homeUrl);
    if (sel.id) {
      const wk = keyFor(sel.id);
      manager.setScope(v.id, wk);
      contextual.set(v.id, { pending: false });
      choice.set(wk, v.id);
    }
    manager.show(v.id);
    reconcile();
    activity?.visit(v.id);
    return { ok: true, viewId: v.id };
  }

  // ---- activity (status of the loaded views) ---------------------------------------------------------------------
  // What a tab shows about a view. Only a view that SHOWS the tab's conversation (identity truth) contributes; a
  // loading view, a placeholder that never showed it, or a reading from another identity contribute nothing.
  const wsIdOf = (scope) => (scope ? scope.slice(scope.indexOf('/') + 1) : null);

  function activityOf(view, expectedKey) {
    const s = activity && view ? activity.summaryOf(view.id) : null;
    if (!s || !s.identityOk || (expectedKey !== undefined && s.identityKey !== expectedKey)) return null;
    const ended = ['ended-unclassified', 'completed', 'interrupted', 'error'].includes(s.generation);
    return {
      phase: s.phase,
      responding: s.generation === 'responding',
      ended,
      draft: s.draft === 'present',
      attention: s.attention === 'pending',
      // Ready, probed at least once, and still no usable answer (composer missing, probe failing, reading expired).
      // Before the first answer, or while loading, nothing is claimed.
      unknown: s.phase === 'ready' && s.observedAt !== null && s.generation === 'unknown',
      // Observed at rest: a fresh reading that says nothing is going on. Never claimed for a view that is not observed (suspended included).
      idle: s.phase === 'ready' && s.observedAt !== null && s.generation !== 'unknown' && s.generation !== 'responding' && !s.stale,
      stale: s.stale,
      uncertain: s.uncertain === true,
      evidence: s.evidence
    };
  }

  // Derived from the loaded views only; nothing persisted, nothing loaded to compute it. A workspace appears only if
  // some of its views are loaded: a workspace whose conversations were never opened says nothing (it is NOT "idle").
  function getWorkspaceActivity() {
    const out = {};
    for (const v of manager.list()) {
      const id = wsIdOf(v.scope);
      if (!id) continue;
      const a = activityOf(v);
      const row = out[id] || (out[id] = { responding: 0, attention: 0, drafts: 0, loaded: 0, observed: 0 });
      row.loaded += 1;
      if (!a) continue;
      row.observed += 1;
      if (a.responding) row.responding += 1;
      if (a.attention) row.attention += 1;
      if (a.draft) row.drafts += 1;
    }
    return out;
  }

  // ---- global activity (M01-I3B-2H) --------------------------------------------------------------------------------
  // A projection of the SAME per-view summaries, across every workspace: totals for the top bar and groups for the
  // activity center. Derived on demand, never stored, never loads a view; a conversation that was never loaded is absent.
  const STATE_ORDER = ['responding', 'attention', 'draft'];

  function getGlobalActivity() {
    const sel = selectedWorkspace();
    const all = mine(bindings.all());
    const byKey = new Map(all.map((b) => [b.conversationKey, b]));
    const labelOf = new Map(sel.options.map((o) => [o.id, o.label]));
    const totals = { responding: 0, attention: 0, drafts: 0, observed: 0, loaded: 0, suspended: manager.suspendedList().length };
    const groups = new Map();
    for (const v of manager.list()) {
      totals.loaded += 1;
      const a = activityOf(v);
      if (!a) continue;
      totals.observed += 1;
      if (a.responding) totals.responding += 1;
      if (a.attention) totals.attention += 1;
      if (a.draft) totals.drafts += 1;
      if (!(a.responding || a.attention || a.draft)) continue;
      const wsId = wsIdOf(v.scope);
      if (!wsId) continue;                     // unbound conversations have their own section (getUnbound)
      const gk = wsId || '';
      const b = v.identity.state === 'durable' ? byKey.get(v.identity.key) : null;
      const bound = Boolean(b && v.scope && wsKeyOf(b) === v.scope);
      if (!groups.has(gk)) {
        const fallback = all.find((x) => x.workspaceIdentity.workspaceId === wsId);
        groups.set(gk, { id: wsId, key: v.scope, label: wsId ? (labelOf.has(wsId) ? labelOf.get(wsId) : (fallback ? fallback.workspaceLabel : '')) : '', items: [] });
      }
      groups.get(gk).items.push({
        viewId: v.id,
        bindingId: bound ? b.bindingId : null,
        kind: bound ? 'binding' : 'temporary',
        label: bound ? (b.label || 'Conversa') : (v.identity.state === 'durable' ? 'Conversa' : 'Nova conversa'),
        responding: a.responding, attention: a.attention, draft: a.draft,
        status: bound ? b.status : null,
        needsConfirm: bound ? b.status !== 'linked' : false,
        openable: Boolean(v.scope) && (!bound || (b.status !== 'orphan' && b.status !== 'other-session'))
      });
    }
    const rank = (i) => (i.responding ? 0 : i.attention ? 1 : 2);
    const list = [...groups.values()].map((g) => ({ ...g, items: g.items.sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label)) }));
    list.sort((x, y) => (x.id === null) - (y.id === null) || String(x.id).localeCompare(String(y.id), undefined, { numeric: true }));
    return {
      totals, selectedId: sel.id, groups: list,
      unbound: getUnbound()
    };
  }

  // Resolves what the user asked to open from the activity center against the CURRENT state (never trusting ids alone).
  function resolveActivityTarget({ workspaceId, bindingId, viewId } = {}) {
    if (typeof workspaceId !== 'string') return null;
    const wk = keyFor(workspaceId);
    if (bindingId !== undefined) {
      const b = mine(bindings.all()).find((x) => x.bindingId === bindingId && wsKeyOf(x) === wk);
      return b ? { kind: 'binding', wk, binding: b } : null;
    }
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    return v && v.scope === wk && v.page !== 'destroyed' ? { kind: 'temporary', wk, viewId: v.id } : null;
  }

  // ---- lifecycle (M01-I3C-1) ---------------------------------------------------------------------------------------------------
  // What chat-views/lifecycle.js needs to know about a page to judge whether its resources can be released. Facts only, read from the
  // state that already exists (nothing is stored here for it); the policy and the release are not here.
  //   kind  binding    the page is the tab of a conversation bound to the workspace it lives in
  //         residual   unscoped page that is not the initial one (left over after an unbind, a transfer, a deduplication, ...)
  //         temporary  a page under a workspace without a binding of its own
  //         pristine   the application's initial page
  function lifecycleFacts(viewId) {
    const v = typeof viewId === 'string' ? manager.get(viewId) : null;
    if (!v || v.page === 'destroyed') return null;
    const byKey = new Map(mine(bindings.all()).map((b) => [b.conversationKey, b]));
    const own = v.expectedKey ? byKey.get(v.expectedKey) : null;
    const ownedHere = Boolean(own && v.scope && wsKeyOf(own) === v.scope);
    const there = v.identity.state === 'durable' ? byKey.get(v.identity.key) : null;
    const kind = v.pristine ? 'pristine' : ownedHere ? 'binding' : v.scope === null ? 'residual' : 'temporary';
    return {
      viewId: v.id, kind, scope: v.scope, page: v.page, relation: v.relation, reached: v.reached,
      identity: { ...v.identity }, expectedKey: v.expectedKey,
      selected: v.id === manager.getVisibleId(),
      binding: ownedHere ? { bindingId: own.bindingId, status: own.status, url: own.url } : null,
      conflict: Boolean(v.scope && there && wsKeyOf(there) !== v.scope),
      duplicate: manager.duplicates().some((d) => d.viewIds.includes(v.id)),
      creating: Boolean((contextual.get(v.id) || {}).pending),
      decision: Boolean(notes && normalizeNote(notes(v.id))),
      switching: selectedWorkspace().pending,
      restored: v.restored, restoreMs: v.restoreMs,
      summary: activity ? activity.summaryOf(v.id) : null,
      observed: Boolean(activity && activity.isObserved(v.id)),
      unsentState: manager.unsentStateHintOf(v.id),
      recoveryUrl: ownedHere ? own.url : (v.identity.state === 'durable' ? v.identity.url : '')
    };
  }

  // The view that serves binding `bindingId` right now (the same choice the tabs make), or null.
  function viewIdOfBinding(bindingId) {
    const b = mine(bindings.all()).find((x) => x.bindingId === bindingId);
    if (!b) return null;
    const v = manager.list().find((x) => x.expectedKey === b.conversationKey && x.scope === wsKeyOf(b) && x.identity.state === 'durable' && x.identity.key === b.conversationKey);
    return v ? v.id : null;
  }

  function suspendedList() {
    const byKey = new Map(mine(bindings.all()).map((b) => [b.conversationKey, b]));
    return manager.suspendedList().map((r) => { const b = byKey.get(r.key); return { viewId: r.id, key: r.key, at: r.at, kind: b ? 'binding' : 'residual', scope: b ? wsKeyOf(b) : null, bindingId: b ? b.bindingId : null }; });
  }

  // ---- mode and state ------------------------------------------------------------------------------------------
  // The chat tab appears or disappears. On appearing, the right view is chosen BEFORE it is attached, so a stale
  // chat of another workspace is never on screen, not even for a frame.
  function setMode(next) {
    if (next !== 'chat' && next !== 'terminal') return;
    mode = next;
    reconcile();
    manager.setAttached(next === 'chat');
  }

  // The page on screen shows a conversation that is bound to ANOTHER workspace than the one the page lives in. Nothing is
  // changed by detecting it: the UI offers going there, an explicit transfer, or going back.
  // A note is text (a failure) or { kind, code, text } (a question for the user); the page on screen shows at most one.
  const normalizeNote = (n) => (!n ? null : (typeof n === 'string' ? { kind: 'pending', code: 'pending', text: n } : n));

  function conflictOf(visible, all, sel) {
    if (!visible || !visible.scope || visible.identity.state !== 'durable' || !manager.isAttached()) return null;
    const b = all.find((x) => x.conversationKey === visible.identity.key);
    if (!b || wsKeyOf(b) === visible.scope) return null;
    const labelOf = new Map(sel.options.map((o) => [o.id, o.label]));
    const here = wsIdOf(visible.scope);
    const there = b.workspaceIdentity.workspaceId;
    return {
      viewId: visible.id,
      boundTo: { id: there, label: labelOf.has(there) ? labelOf.get(there) : b.workspaceLabel, status: b.status, openable: b.status !== 'orphan' && b.status !== 'other-session' },
      current: { id: here, label: labelOf.get(here) || '' },
      transferable: here === sel.id
    };
  }

  function getState() {
    const sel = selectedWorkspace();
    const wk = keyFor(sel.id);
    const all = mine(bindings.all());
    const views = manager.list();
    const visibleId = manager.getVisibleId();
    const here = wk ? all.filter((b) => wsKeyOf(b) === wk) : [];
    const labelCount = new Map();
    for (const b of here) labelCount.set(b.label || '', (labelCount.get(b.label || '') || 0) + 1);
    // The view of a tab is the one that SHOWS that conversation under this workspace (identity, not expectation),
    // preferring the one opened for it; a view still on its way to it (identity not known yet) counts as well.
    const showing = (b) => views.filter((v) => v.scope === wk && ((v.identity.state === 'durable' && v.identity.key === b.conversationKey) || (v.expectedKey === b.conversationKey && (v.relation === REL.LOADING || (v.relation === REL.LEFT && !v.reached)))));
    // A view that really shows the conversation wins over a placeholder opened for it that has not (yet) shown it.
    const viewOf = (b) => {
      const candidates = showing(b);
      const shows = (v) => v.identity.state === 'durable' && v.identity.key === b.conversationKey;
      return candidates.find((v) => shows(v) && v.expectedKey === b.conversationKey) || candidates.find(shows) || candidates[0] || null;
    };
    const tabs = here.map((b) => {
      const v = viewOf(b);
      return {
        bindingId: b.bindingId, label: b.label || 'Conversa', status: b.status,
        hint: (labelCount.get(b.label || '') || 0) > 1 ? b.conversationKey.slice(-4) : '',
        loaded: Boolean(v), loading: Boolean(v && v.page === 'loading'), failed: Boolean(v && v.page === 'error'),
        suspended: !v && manager.isSuspended(b.conversationKey),
        lifecycle: lifecycle && v ? lifecycle.describe(v.id) : null,
        activity: v ? activityOf(v, b.conversationKey) : null,
        active: Boolean(v && v.id === visibleId), needsConfirm: b.status !== 'linked',
        relation: v ? v.relation : null
      };
    });
    const byKey = new Map(all.map((b) => [b.conversationKey, b]));
    const tabViewIds = new Set(here.map(viewOf).filter(Boolean).map((v) => v.id));
    const duplicated = new Set(manager.duplicates().flatMap((d) => d.viewIds));
    const temporaries = views.filter((v) => wk && v.scope === wk && !tabViewIds.has(v.id)).map((v) => {
      const other = v.identity.state === 'durable' ? byKey.get(v.identity.key) : null;
      const elsewhere = other && wsKeyOf(other) !== wk ? other : null;
      let label = 'Nova conversa';
      if (v.identity.state === 'durable') label = other ? `${other.label || 'Conversa'}${elsewhere ? ` · ${elsewhere.workspaceIdentity.workspaceId}` : ''}` : 'Conversa';
      return {
        viewId: v.id, label, relation: v.relation, active: v.id === visibleId, loading: v.page === 'loading', failed: v.page === 'error',
        activity: activityOf(v),
        lifecycle: lifecycle ? lifecycle.describe(v.id) : null,
        note: notes ? ((normalizeNote(notes(v.id)) || {}).text || '') : '',
        warning: v.relation === REL.DIVERGED || v.relation === REL.LEFT || Boolean(elsewhere) || duplicated.has(v.id), bound: Boolean(other)
      };
    });
    const visible = visibleId ? manager.get(visibleId) : null;
    let empty = null;
    if (!sel.id) empty = visible ? null : 'no-workspace';
    else if (!visible || visible.scope !== wk) empty = !here.length ? 'no-conversations' : (here.every((b) => b.status !== 'linked') ? 'not-verified' : 'select-conversation');
    const option = sel.options.find((o) => o.id === sel.id);
    return {
      mode,
      workspace: sel.id ? { key: wk, id: sel.id, label: option ? option.label : '', origin: sel.origin, pending: sel.pending } : null,
      tabs, temporaries, empty,
      activeViewId: visible ? visible.id : null,
      conflict: conflictOf(visible, all, sel),
      pending: visible && notes && visible.scope ? normalizeNote(notes(visible.id, 'banner')) : null,
      visibleRelation: visible ? visible.relation : null,
      duplicates: manager.duplicates().length
    };
  }

  // ---- runtime provider (contract of chat/runtime-contract.js; nothing consumes it yet) -----------------------------
  const provider = {
    getRuntime(bindingId) {
      const b = mine(bindings.all()).find((x) => x.bindingId === bindingId);
      const v = b ? manager.findByKey(b.conversationKey) : null;
      if (!v) return null;
      const base = manager.runtimeOf(v.id);
      const live = activity ? activity.runtimeOf(v.id) : null;
      return live ? Object.freeze({ ...base, generation: live.generation, draft: live.draft, attention: live.attention }) : base;
    },
    subscribe(listener) {
      const last = new Map();
      return manager.onChange(() => {
        for (const b of mine(bindings.all())) {
          const v = manager.findByKey(b.conversationKey);
          if (!v) continue;
          const runtime = manager.runtimeOf(v.id);
          const sig = `${runtime.epoch}/${runtime.page.value}/${runtime.identity.key}`;
          if (last.get(b.bindingId) !== sig) { last.set(b.bindingId, sig); listener(b.bindingId, runtime); }
        }
      });
    }
  };

  const offManager = manager.onChange(() => reconcile());
  // A status change redraws the strip; it never reconciles (observing cannot change which view is shown).
  const offActivity = activity ? activity.onChange(() => { rememberBusy(); emit(); }) : () => {};
  // New pending attention, translated to what the user needs to see (which conversation, in which workspace).
  const offAttention = activity && onAttention ? activity.onAttention(({ viewId }) => {
    const v = manager.get(viewId);
    if (!v || !v.scope) return;
    const g = getGlobalActivity().groups.find((x) => x.key === v.scope);
    const item = g && g.items.find((i) => i.viewId === viewId);
    if (item) onAttention({ viewId, workspaceId: g.id, workspaceLabel: g.label, label: item.label, bindingId: item.bindingId, kind: item.kind, openable: item.openable });
  }) : () => {};
  const offSelection = selection.onChange(() => reconcile());

  return {
    reconcile, getWorkspaceActivity, getGlobalActivity, resolveActivityTarget, setMode, selectBinding, newConversation, selectTemporary, openUnscoped, getState,
    getUnbound, openUnbound, releaseConversation, lifecycleFacts, viewIdOfBinding, suspendedList, selectedWorkspaceKey: () => keyFor(selectedWorkspace().id),
    setLifecycle: (lc) => { lifecycle = lc && typeof lc.describe === 'function' ? lc : null; }, contextViews, confirmAdopted, moveToBinding, backFromConflict, pagesShowing, releasePage, focusExisting, isBusy,
    urlOf: (viewId) => { const h = typeof viewId === 'string' ? manager.handleOf(viewId) : null; return h && !h.isDestroyed() ? h.getUrl() : ''; },
    canGoBack: (viewId) => manager.canGoBack(viewId),
    goBackPage: (viewId) => manager.goBack(viewId),
    setNoteProvider: (fn) => { notes = typeof fn === 'function' ? fn : null; },
    // Read-only view of one page for the creation service: scope, identity (from the URL only), epoch and lifecycle.
    viewInfo: (viewId) => (typeof viewId === 'string' ? manager.get(viewId) : null),
    getVisibleUrl: () => { const id = manager.getVisibleId(); const h = id && manager.isAttached() ? manager.handleOf(id) : null; return h && !h.isDestroyed() ? h.getUrl() : ''; },
    onChange(l) { listeners.add(l); return () => listeners.delete(l); },
    runtime: provider,
    _debugViews: () => manager.list(),
    // The user can see the visible view now (chat tab shown, window interactive): acknowledges its pending attention.
    visitVisible: () => (activity ? activity.visitVisible() : false),
    stop() { offManager(); offSelection(); offActivity(); offAttention(); listeners.clear(); }
  };
}

module.exports = { createChatNavigator, wsKeyOf, RUNTIME_PROVIDER_METHODS };
