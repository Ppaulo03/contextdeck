'use strict';

// Workspace-first association (M01-I3B-3). Plain Node.
//
// "I opened the chat inside a workspace -> the chat belongs to that workspace." A page that lives under a workspace (its
// scope) was put there by an explicit user action (Nova conversa, opening a chat of that workspace, opening a page from the
// exceptional list). When such a page shows a conversation that has no binding, this service binds it to THAT workspace
// through the chat bindings service (`adopt`). Nothing here is reachable from the renderer: the provenance (which workspace
// the page lives in, and whether the user started a creation there) comes from the navigator, and the destination is verified
// by the bindings service against Herdr.
//
// What counts as the user's act (and what does not):
//   * `pending` page: the user clicked "Nova conversa" in workspace A and the page has not shown a conversation yet. When it
//     gets an id it is A's, even if the user has since selected B (the context was captured at the click). No `workspace.focus`.
//   * the page is on screen (chat tab, visible view): the user is looking at it and can only have navigated it (the sidebar,
//     a link). Opening a conversation there is choosing that context.
//   * anything else - a hidden page changing route, a reload, a redirect, a restored view, a late event - is passive and never
//     binds. It is left alone until the user looks at it (or presses "Tentar vincular").
// A conversation bound to another workspace is never moved: it is a conflict, offered to the user as go / transfer / back.
// A refused adoption (workspace suspect or unavailable, limit...) keeps the page in its workspace as a pending association
// with a note and a direct action to retry; nothing is destroyed.
function createContextAdoption({ session, navigator, bindings, selection, wait = (ms) => new Promise((r) => setTimeout(r, ms)), leaveTimeoutMs = 2500 }) {
  const pendingNotes = new Map();      // viewId -> { code, text }
  // Conversations the user explicitly unbound while a page still shows them. Without this the next evaluation would bind them
  // again (the page is on screen, in the workspace). Forgotten as soon as no page shows the conversation any more, so opening
  // it again later, in a workspace, is a new act.
  const declined = new Set();
  const redirecting = new Set();        // pages already sent back to their own tab's conversation (going back is asynchronous: once)
  let resolving = false;

  const TEXT = {
    workspace_suspect: 'A identidade do workspace nao foi verificada (parece ter sido recriado). Reassocie uma conversa dele para reconfirma-lo e tente de novo.',
    workspace_unavailable: 'Sem conexao com o Herdr: o workspace nao pode ser verificado.',
    workspace_not_found: 'O workspace desta conversa nao existe mais.',
    limit_reached: 'Limite de conversas deste workspace atingido.'
  };
  const noteFor = (code) => `Conversa ainda nao vinculada: ${TEXT[code] || 'nao foi possivel verificar o destino.'}`;

  // `force`: the user pressed "Tentar vincular" on this page (an explicit act, so visibility is not required).
  function evaluate(v, { force = false } = {}) {
    if (v.identity.state !== 'durable') { pendingNotes.delete(v.viewId); return 'waiting'; }
    const existing = bindings.lookup(v.identity.url);
    if (existing) {
      pendingNotes.delete(v.viewId);
      if (existing.workspaceIdentity.session === session && existing.workspaceIdentity.workspaceId === v.workspaceId) {
        if (v.expectedKey === v.identity.key) return 'linked';
        // Never two pages for one conversation: if it already has its tab in this workspace, the page the user opened it in does not
        // become a second one - the user is taken to the existing tab and this page goes back to what it showed.
        const tab = navigator.contextViews().find((x) => x.viewId !== v.viewId && x.scope === v.scope && x.identity.key === v.identity.key && x.expectedKey === v.identity.key);
        if (tab) {
          if (!(v.visible || v.pending)) return 'passive';
          if (!redirecting.has(v.viewId)) { redirecting.add(v.viewId); navigator.focusExisting(v.viewId, tab.viewId); }
          return 'redirected';
        }
        navigator.confirmAdopted(v.viewId);
        return 'linked';
      }
      return 'conflict';                         // shown by the navigator; never moved here
    }
    if (declined.has(v.identity.key) && !force) return 'declined';
    if (!(v.pending || v.visible || force)) return 'passive';
    const r = bindings.adopt({ target: { session, workspaceId: v.workspaceId }, url: v.identity.url });
    if (!r.ok) {
      if (r.error.code === 'conflict') { pendingNotes.delete(v.viewId); return 'conflict'; }
      pendingNotes.set(v.viewId, { code: r.error.code, text: noteFor(r.error.code) });
      return `pending:${r.error.code}`;
    }
    pendingNotes.delete(v.viewId);
    navigator.confirmAdopted(v.viewId);
    return 'adopted';
  }

  // Called when pages or the selection changed. Cheap: only the pages that live in a workspace and show a conversation.
  function resolve() {
    if (resolving) return;
    resolving = true;
    try {
      let changed = false;
      const views = navigator.contextViews();
      const shown = new Set(views.filter((x) => x.identity.state === 'durable').map((x) => x.identity.key));
      for (const key of [...declined]) if (!shown.has(key)) declined.delete(key);
      for (const id of [...redirecting]) { const x = views.find((y) => y.viewId === id); if (!x || x.identity.state !== 'durable' || x.expectedKey === x.identity.key) redirecting.delete(id); }
      for (const v of views) {
        if (v.identity.state !== 'durable') continue;
        const out = evaluate(v);
        if (out === 'adopted') changed = true;
      }
      if (changed) navigator.reconcile();
    } finally { resolving = false; }
  }

  const find = (viewId) => navigator.contextViews().find((v) => v.viewId === viewId) || null;
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  // ---- the user's decisions on a page ------------------------------------------------------------------------------------
  function retry({ viewId } = {}) {
    const v = find(viewId);
    if (!v) return fail('view_not_found', 'Conversa nao encontrada neste workspace.');
    const out = evaluate(v, { force: true });
    if (out === 'adopted' || out === 'linked') { navigator.reconcile(); return { ok: true }; }
    if (out === 'conflict') return fail('conflict', 'Esta conversa pertence a outro workspace.');
    const note = pendingNotes.get(viewId);
    return fail(note ? note.code : 'not_ready', note ? note.text : 'A conversa ainda nao tem identidade persistente.');
  }

  // Explicit transfer to the workspace the page lives in. Same rules and confirmation as the I3A reassignment; only possible
  // while that workspace is the selected one (the user is looking at it), so the form-staleness check of I3A holds.
  // After the binding is here, a conversation must be ONE tab. If another page already shows it (the one the conversation had in its
  // old workspace), that page becomes the tab and the page the user clicked in goes back in its history; with no history to go back to,
  // the clicked page stays the tab and the other one leaves the workspace (kept, unscoped, never destroyed).
  async function transfer({ viewId } = {}) {
    const v = find(viewId);
    if (!v || v.identity.state !== 'durable') return fail('view_not_found', 'Conversa nao encontrada neste workspace.');
    const b = bindings.lookup(v.identity.url);
    if (!b) return fail('not_bound', 'Esta conversa nao tem vinculo para transferir.');
    const sel = selection.getState();
    const current = sel.selected ? sel.selected.workspaceId : null;
    if (current !== v.workspaceId) return fail('context_changed', 'O workspace selecionado mudou. Revise a escolha.');
    const r = bindings.reassign({
      bindingId: b.bindingId,
      target: { session, workspaceId: v.workspaceId },
      selectedAtOpen: current,
      targetChosen: true,                        // the button is the explicit choice; set here, never taken from the renderer
      confirmReassign: true
    });
    if (!r.ok) return r;
    const key = v.identity.key;
    const others = navigator.pagesShowing(key).filter((p) => p.viewId !== viewId);
    if (others.length) {
      if (navigator.canGoBack(viewId) && navigator.goBackPage(viewId) && (await waitLeft(viewId, key))) { navigator.reconcile(); return { ok: true }; }
      for (const o of others) navigator.releasePage(o.viewId);
    }
    navigator.confirmAdopted(viewId);
    navigator.reconcile();
    return { ok: true };
  }

  async function waitLeft(viewId, key) {
    for (let waited = 0; waited <= leaveTimeoutMs; waited += 25) {          // bounded by count, not by the clock
      const now = navigator.viewInfo(viewId);
      if (!now || now.identity.key !== key) return true;
      await wait(25);
    }
    return false;
  }

  const back = ({ viewId } = {}) => navigator.backFromConflict(viewId);
  // "Ir para <workspace>", first half: the page that opened the other workspace's conversation does the local "Voltar" - it
  // returns to what this workspace had (its own history, or the previous page) - so that, when the user comes back, the conflicting
  // conversation is not still sitting here. Going back in history is asynchronous: the next step (opening the conversation in its
  // workspace) must not start until the page has really left it, or that step would take this very page with it. Bounded wait;
  // if the page does not leave, nothing else happens and the modal stays for another choice.
  async function leave({ viewId } = {}) {
    const info = navigator.viewInfo(viewId);
    if (!info || info.page === 'destroyed') return fail('view_not_found', 'Conversa nao encontrada.');
    const before = info.identity.key;
    const r = navigator.backFromConflict(viewId);
    if (!r.ok) return r;
    if (r.how !== 'history') return { ok: true };
    for (let waited = 0; waited <= leaveTimeoutMs; waited += 25) {          // bounded by count, not by the clock
      const now = navigator.viewInfo(viewId);
      if (!now || now.identity.key !== before) return { ok: true };
      await wait(25);
    }
    return fail('back_failed', 'A pagina nao voltou para a conversa anterior. Tente de novo.');
  }

  // The user removed the binding of this conversation: leave it unbound while a page shows it.
  const decline = (key) => { if (typeof key === 'string') declined.add(key); };

  return { resolve, retry, transfer, back, leave, decline, noteOf: (viewId) => (pendingNotes.get(viewId) || {}).text || '', pending: () => [...pendingNotes.keys()] };
}

module.exports = { createContextAdoption };
