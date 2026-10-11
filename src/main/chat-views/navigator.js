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
function createChatNavigator({ manager, session, bindings, selection, prefs, homeUrl, activity = null }) {
  const listeners = new Set();
  let mode = 'terminal';
  let reconciling = false;
  let again = false;
  const choice = new Map();          // workspace key -> id of a temporary view the user picked there

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
    for (const v of manager.list()) {
      if (v.expectedKey) {
        const b = byKey.get(v.expectedKey);
        if (!b) manager.setExpected(v.id, null);
        else if (v.scope !== wsKeyOf(b)) {
          if (v.relation === REL.MATCH || v.relation === REL.LOADING) manager.setScope(v.id, wsKeyOf(b));
          else manager.setExpected(v.id, null);
        }
      } else if (v.identity.state === 'durable') {
        const b = byKey.get(v.identity.key);
        if (b && v.scope !== null && wsKeyOf(b) === v.scope) manager.setExpected(v.id, v.identity.key);
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
  function newConversation({ workspaceKey } = {}) {
    const g = guard(workspaceKey);
    if (!g.ok) return g;
    const pristine = manager.list().find((v) => v.scope === null && v.pristine && v.relation === REL.TEMPORARY);
    let id;
    if (pristine) { manager.setScope(pristine.id, g.wk); id = pristine.id; }
    else id = manager.create({ url: homeUrl, scope: g.wk });
    if (!id) return fail('open_failed', 'Nao foi possivel abrir uma nova conversa.');
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

  // ---- mode and state ------------------------------------------------------------------------------------------
  // The chat tab appears or disappears. On appearing, the right view is chosen BEFORE it is attached, so a stale
  // chat of another workspace is never on screen, not even for a frame.
  function setMode(next) {
    if (next !== 'chat' && next !== 'terminal') return;
    mode = next;
    reconcile();
    manager.setAttached(next === 'chat');
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
        bindingId: b.bindingId, label: b.label || '(sem rótulo)', role: b.role, status: b.status,
        hint: (labelCount.get(b.label || '') || 0) > 1 ? b.conversationKey.slice(-4) : '',
        loaded: Boolean(v), loading: Boolean(v && v.page === 'loading'), failed: Boolean(v && v.page === 'error'),
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
      if (v.identity.state === 'durable') label = other ? `${other.label || '(sem rótulo)'}${elsewhere ? ` · ${elsewhere.workspaceIdentity.workspaceId}` : ''}` : 'Conversa não vinculada';
      return {
        viewId: v.id, label, relation: v.relation, active: v.id === visibleId, loading: v.page === 'loading', failed: v.page === 'error',
        activity: activityOf(v),
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
  const offActivity = activity ? activity.onChange(() => emit()) : () => {};
  const offSelection = selection.onChange(() => reconcile());

  return {
    reconcile, getWorkspaceActivity, setMode, selectBinding, newConversation, selectTemporary, openUnscoped, getState,
    getVisibleUrl: () => { const id = manager.getVisibleId(); const h = id && manager.isAttached() ? manager.handleOf(id) : null; return h && !h.isDestroyed() ? h.getUrl() : ''; },
    onChange(l) { listeners.add(l); return () => listeners.delete(l); },
    runtime: provider,
    _debugViews: () => manager.list(),
    // The user can see the visible view now (chat tab shown, window interactive): acknowledges its pending attention.
    visitVisible: () => (activity ? activity.visitVisible() : false),
    stop() { offManager(); offSelection(); offActivity(); listeners.clear(); }
  };
}

module.exports = { createChatNavigator, wsKeyOf, RUNTIME_PROVIDER_METHODS };
