'use strict';

const crypto = require('node:crypto');
const { parseChatUrl } = require('../chat/conversation-identity');
const { LIMITS, ORIGINS, err, validWorkspaceIdentity, contextKey, sameWorkspace, normalizeLabel, normalizeRole, workspaceStatus } = require('./model');

// Domain operations of the chat bindings (M01-I3A). Plain Node, deterministic, testable without Electron.
//
// Authority: Herdr (through the observer) says which workspaces exist; this module only stores which
// conversations the user attached to them. Nothing here sends a command to Herdr, moves its focus, reads a
// conversation or touches the ChatGPT page: the URL of the current page is handed in by the IPC layer.
//
// Safety rules (see docs/architecture.md, "Chat bindings"):
//   * a write needs a verified target: Herdr connected, same session, workspace present, no selection pending;
//   * the form states which workspace was selected when it opened (`selectedAtOpen`); if the selection moved
//     meanwhile nothing is written (`context_changed`), so a slow form can never land on the old or new workspace;
//   * when the destination is only an estimate (selection follows Herdr's last focus, or was restored), the user
//     must confirm it explicitly (`confirmTarget`) unless the session has a single workspace;
//   * a conversation belongs to one workspace: binding it elsewhere is a `conflict`, resolved only by an explicit
//     `reassign` (`confirmReassign`); nothing is ever overwritten silently;
//   * unbinding or losing a workspace never deletes anything but the binding the user removed.

const idOf = () => `b_${crypto.randomBytes(8).toString('hex')}`;
const slug = (reason) => reason.replace(/-/g, '_');

function createChatBindings({ store, session, observer, selection, now = () => Date.now(), newId = idOf }) {
  const clone = (data) => JSON.parse(JSON.stringify(data));

  // ---- what Herdr says right now -------------------------------------------------------------------------------
  function live() {
    const obs = observer.getState();
    const connected = obs.connection === 'connected' && Boolean(obs.model);
    const workspaces = connected ? obs.model.workspaces : [];
    return { connected, workspaces, byId: new Map(workspaces.map((w) => [w.id, w])) };
  }

  // linked      workspace exists and matches what we recorded (label or directory; a rename keeps the directory)
  // suspect     the id exists but BOTH label and directory differ: probably a recreated session reusing the id
  // orphan      this session, connected, and the workspace is gone
  // unverified  Herdr is not connected, so nothing can be said
  // other-session  belongs to another Herdr session than the configured one: preserved, not judged
  function statusOf(binding, snapshot, data) {
    const identity = binding.workspaceIdentity;
    return workspaceStatus({ identity, session, connected: snapshot.connected, workspace: snapshot.byId.get(identity.workspaceId), recorded: data.contexts[contextKey(identity)] });
  }

  function viewOf(binding, snapshot, data) {
    const identity = binding.workspaceIdentity;
    const workspace = identity.session === session ? snapshot.byId.get(identity.workspaceId) : null;
    const recorded = data.contexts[contextKey(identity)];
    return {
      ...binding,
      workspaceIdentity: { ...identity },
      status: statusOf(binding, snapshot, data),
      workspaceLabel: workspace ? workspace.label : (recorded ? recorded.label : '')
    };
  }

  // Keeps the recovery metadata of linked workspaces current (a rename or a changed directory must not make a
  // later check look like a recreated workspace). Metadata only; failures are ignored; never touches bindings.
  function refreshContexts(snapshot) {
    if (!store.info().writable || !snapshot.connected) return;
    const data = store.get();
    const next = {};
    for (const b of data.bindings) {
      if (statusOf(b, snapshot, data) !== 'linked') continue;
      const ws = snapshot.byId.get(b.workspaceIdentity.workspaceId);
      const key = contextKey(b.workspaceIdentity);
      const recorded = data.contexts[key];
      const directory = ws.directory || '';
      if (!recorded || recorded.label !== ws.label || recorded.directory !== directory) next[key] = { ...b.workspaceIdentity, label: ws.label, directory, seenAt: now() };
    }
    if (!Object.keys(next).length) return;
    try { const draft = clone(data); Object.assign(draft.contexts, next); store.save(draft); } catch { /* Metadata only. */ }
  }

  // ---- guarded writes ------------------------------------------------------------------------------------------
  function commit(mutate) {
    const draft = clone(store.get());
    const result = mutate(draft);
    if (result && result.ok === false) return result;
    try { store.save(draft); } catch (error) {
      if (error && error.code === 'store_readonly') return err('store_readonly', 'Os vinculos estao em modo somente leitura (arquivo ilegivel ou de versao mais nova).');
      return err('write_failed', 'Nao foi possivel gravar os vinculos. Nada foi alterado.');
    }
    return result || { ok: true };
  }

  // The destination of a write must be verifiable and explicitly acknowledged. See the rules at the top.
  function checkTarget(target, { selectedAtOpen, confirmTarget, targetChosen }) {
    if (!validWorkspaceIdentity(target)) return err('invalid_target', 'Destino invalido.');
    if (selectedAtOpen !== null && typeof selectedAtOpen !== 'string') return err('invalid_request', 'Pedido incompleto: falta o workspace selecionado ao abrir.');
    if (target.session !== session) return err('session_mismatch', 'O destino pertence a outra sessao do Herdr.');
    const snapshot = live();
    if (!snapshot.connected) return err('workspace_unavailable', 'Sem conexao com o Herdr: nao e possivel verificar o workspace de destino.');
    const sel = selection.getState();
    if (sel.pending) return err('selection_pending', 'Uma troca de workspace esta em andamento. Aguarde e revise o destino.');
    const current = sel.selected ? sel.selected.workspaceId : null;
    if (current !== selectedAtOpen) return err('context_changed', 'O workspace selecionado mudou enquanto o formulario estava aberto. Revise o destino.', { selected: current });
    const workspace = snapshot.byId.get(target.workspaceId);
    if (!workspace) return err('workspace_not_found', 'Esse workspace nao existe mais na sessao.');
    // `targetChosen`: the user picked this very workspace in the form (a deliberate choice, not an estimate).
    const explicit = targetChosen === true || snapshot.workspaces.length === 1 || (sel.selected && sel.selected.origin === 'dock' && sel.selected.workspaceId === target.workspaceId);
    if (!explicit && confirmTarget !== true) {
      return err('confirmation_required', 'O destino e uma estimativa (acompanha o foco do Herdr). Confirme o workspace de destino.', { target: { ...target } });
    }
    return { ok: true, workspace, snapshot };
  }

  const recordContext = (draft, target, workspace) => {
    draft.contexts[contextKey(target)] = { session: target.session, workspaceId: target.workspaceId, label: workspace.label, directory: workspace.directory || '', seenAt: now() };
  };
  const find = (data, bindingId) => data.bindings.find((b) => b.bindingId === bindingId);
  const unknownBinding = () => err('binding_not_found', 'Vinculo nao encontrado.');

  // ---- operations ----------------------------------------------------------------------------------------------
  function bind({ target, url, origin, label, role, selectedAtOpen, confirmTarget, targetChosen } = {}) {
    const identity = parseChatUrl(url);
    if (!identity.ok) return err(slug(identity.reason), identity.message);
    const l = normalizeLabel(label); if (!l.ok) return l;
    const r = role === undefined ? null : normalizeRole(role); if (r && !r.ok) return r;   // legacy callers only
    const checked = checkTarget(target, { selectedAtOpen, confirmTarget, targetChosen });
    if (!checked.ok) return checked;
    const data = store.get();
    const existing = data.bindings.find((b) => b.conversationKey === identity.conversationKey);
    if (existing) {
      const view = viewOf(existing, checked.snapshot, data);
      return sameWorkspace(existing.workspaceIdentity, target)
        ? err('already_bound', 'Esta conversa ja esta vinculada a este workspace.', { binding: view })
        : err('conflict', 'Esta conversa ja esta vinculada a outro workspace. Reassocie explicitamente para move-la.', { binding: view });
    }
    // A workspace whose identity is in doubt (same id, label and directory both changed) is not made trustworthy by writing
    // into it: that would overwrite the recovery record. The user re-confirms it by reassigning one of its conversations.
    if (data.bindings.some((b) => sameWorkspace(b.workspaceIdentity, target) && statusOf(b, checked.snapshot, data) === 'suspect')) {
      return err('workspace_suspect', 'A identidade deste workspace nao foi verificada (parece ter sido recriado). Reassocie uma das conversas dele para reconfirma-lo antes de vincular outra.');
    }
    if (data.bindings.length >= LIMITS.bindings) return err('limit_reached', `Limite de ${LIMITS.bindings} vinculos atingido.`);
    if (data.bindings.filter((b) => sameWorkspace(b.workspaceIdentity, target)).length >= LIMITS.perWorkspace) return err('limit_reached', `Limite de ${LIMITS.perWorkspace} conversas por workspace atingido.`);
    const created = now();
    let bindingId = newId();
    while (data.bindings.some((b) => b.bindingId === bindingId)) bindingId = newId();   // ids are unique even if the source repeats
    const binding = {
      bindingId,
      conversationKey: identity.conversationKey,
      url: identity.url,
      label: l.label,
      ...(r ? { role: r.role } : {}),
      origin: ORIGINS.includes(origin) ? origin : 'url',
      workspaceIdentity: { session: target.session, workspaceId: target.workspaceId },
      createdAt: created,
      updatedAt: created
    };
    const done = commit((draft) => { draft.bindings.push(binding); recordContext(draft, target, checked.workspace); });
    if (!done.ok) return done;
    return { ok: true, binding: viewOf(binding, checked.snapshot, store.get()) };
  }

  // Workspace-first association (M01-I3B-3): a page the user opened IN a workspace's context is attached to that workspace.
  // This is NOT reachable from the renderer or the IPC layer: the caller is the main-side context-adoption service, which
  // holds the provenance (the workspace captured when the user acted). Because the context was captured earlier, it does not
  // depend on what is selected now; it still needs a live, verified destination: Herdr connected, same session, the
  // workspace exists and is not suspect (a recreated workspace is not made trustworthy by writing into it). It never moves an
  // existing binding: a conversation bound elsewhere is a `conflict`, resolved only by the explicit `reassign`.
  function adopt({ target, url } = {}) {
    const identity = parseChatUrl(url);
    if (!identity.ok) return err(slug(identity.reason), identity.message);
    if (!validWorkspaceIdentity(target)) return err('invalid_target', 'Destino invalido.');
    if (target.session !== session) return err('session_mismatch', 'O destino pertence a outra sessao do Herdr.');
    const snapshot = live();
    if (!snapshot.connected) return err('workspace_unavailable', 'Sem conexao com o Herdr: nao e possivel verificar o workspace de destino.');
    const workspace = snapshot.byId.get(target.workspaceId);
    if (!workspace) return err('workspace_not_found', 'Esse workspace nao existe mais na sessao.');
    const data = store.get();
    const existing = data.bindings.find((b) => b.conversationKey === identity.conversationKey);
    if (existing) {
      const view = viewOf(existing, snapshot, data);
      return sameWorkspace(existing.workspaceIdentity, target)
        ? { ok: true, already: true, binding: view }
        : err('conflict', 'Esta conversa ja esta vinculada a outro workspace.', { binding: view });
    }
    if (data.bindings.some((b) => sameWorkspace(b.workspaceIdentity, target) && statusOf(b, snapshot, data) === 'suspect')) {
      return err('workspace_suspect', 'A identidade deste workspace nao foi verificada (parece ter sido recriado). Reassocie uma das conversas dele para reconfirma-lo.');
    }
    if (data.bindings.length >= LIMITS.bindings) return err('limit_reached', `Limite de ${LIMITS.bindings} vinculos atingido.`);
    if (data.bindings.filter((b) => sameWorkspace(b.workspaceIdentity, target)).length >= LIMITS.perWorkspace) return err('limit_reached', `Limite de ${LIMITS.perWorkspace} conversas por workspace atingido.`);
    const created = now();
    let bindingId = newId();
    while (data.bindings.some((b) => b.bindingId === bindingId)) bindingId = newId();
    const binding = { bindingId, conversationKey: identity.conversationKey, url: identity.url, label: '', origin: 'context', workspaceIdentity: { session: target.session, workspaceId: target.workspaceId }, createdAt: created, updatedAt: created };
    const done = commit((draft) => { draft.bindings.push(binding); recordContext(draft, target, workspace); });
    if (!done.ok) return done;
    return { ok: true, binding: viewOf(binding, snapshot, store.get()) };
  }

  function update({ bindingId, label } = {}) {
    if (label === undefined) return err('invalid_request', 'Nada para alterar.');
    const l = normalizeLabel(label); if (!l.ok) return l;
    if (!find(store.get(), bindingId)) return unknownBinding();
    const done = commit((draft) => {
      const b = find(draft, bindingId);
      b.label = l.label;
      b.updatedAt = now();
    });
    if (!done.ok) return done;
    return { ok: true, binding: viewOf(find(store.get(), bindingId), live(), store.get()) };
  }

  function unbind({ bindingId } = {}) {
    if (!find(store.get(), bindingId)) return unknownBinding();
    const done = commit((draft) => {
      const gone = find(draft, bindingId);
      draft.bindings = draft.bindings.filter((b) => b.bindingId !== bindingId);
      if (!draft.bindings.some((b) => sameWorkspace(b.workspaceIdentity, gone.workspaceIdentity))) delete draft.contexts[contextKey(gone.workspaceIdentity)];
    });
    return done.ok ? { ok: true } : done;
  }

  // Explicitly moves a binding to the verified target. Also the way to adopt an orphan, and to re-confirm a
  // `suspect` binding onto the workspace that now carries its id (moving it to itself refreshes the record).
  function reassign({ bindingId, target, selectedAtOpen, confirmTarget, targetChosen, confirmReassign } = {}) {
    if (confirmReassign !== true) return err('confirmation_required', 'A reassociacao precisa de confirmacao explicita.', { reassign: true });
    if (!find(store.get(), bindingId)) return unknownBinding();
    const checked = checkTarget(target, { selectedAtOpen, confirmTarget, targetChosen });
    if (!checked.ok) return checked;
    const before = find(store.get(), bindingId);
    if (!sameWorkspace(before.workspaceIdentity, target) &&
        store.get().bindings.filter((b) => sameWorkspace(b.workspaceIdentity, target)).length >= LIMITS.perWorkspace) {
      return err('limit_reached', `Limite de ${LIMITS.perWorkspace} conversas por workspace atingido.`);
    }
    const done = commit((draft) => {
      const b = find(draft, bindingId);
      const from = b.workspaceIdentity;
      b.workspaceIdentity = { session: target.session, workspaceId: target.workspaceId };
      b.updatedAt = now();
      recordContext(draft, target, checked.workspace);
      if (!sameWorkspace(from, target) && !draft.bindings.some((x) => sameWorkspace(x.workspaceIdentity, from))) delete draft.contexts[contextKey(from)];
    });
    if (!done.ok) return done;
    return { ok: true, binding: viewOf(find(store.get(), bindingId), checked.snapshot, store.get()) };
  }

  // ---- queries -------------------------------------------------------------------------------------------------
  function list(identity) {
    if (!validWorkspaceIdentity(identity)) return [];
    const snapshot = live();
    const data = store.get();
    return data.bindings.filter((b) => sameWorkspace(b.workspaceIdentity, identity)).map((b) => viewOf(b, snapshot, data));
  }

  // Every binding with its live status, for consumers that navigate (chat views). Read-only.
  function all() {
    const snapshot = live();
    const data = store.get();
    return data.bindings.map((b) => viewOf(b, snapshot, data));
  }

  function listOrphans() {
    const snapshot = live();
    const data = store.get();
    return data.bindings.map((b) => viewOf(b, snapshot, data)).filter((b) => b.status === 'orphan');
  }

  function lookup(url) {
    const identity = parseChatUrl(url);
    if (!identity.ok) return null;
    const data = store.get();
    const b = data.bindings.find((x) => x.conversationKey === identity.conversationKey);
    return b ? viewOf(b, live(), data) : null;
  }

  // Indicator for the page that is loaded now: bound to the selected workspace, to another one, not bound, or
  // identity not known yet. Never changes the page, the selection or Herdr.
  function describeCurrent(url, snapshot = live(), data = store.get()) {
    const selected = selection.getState().selected;
    const selectedId = selected ? selected.workspaceId : null;
    const identity = url ? parseChatUrl(url) : { ok: false, reason: 'no-page', kind: 'unknown' };
    if (!identity.ok) return { state: 'unknown', reason: identity.reason === 'identity-pending' ? 'new' : identity.reason, selectedId };
    const b = data.bindings.find((x) => x.conversationKey === identity.conversationKey);
    if (!b) return { state: 'unbound', conversationKey: identity.conversationKey, selectedId };
    const binding = viewOf(b, snapshot, data);
    const here = binding.workspaceIdentity.session === session && binding.workspaceIdentity.workspaceId === selectedId;
    return { state: here ? 'bound-here' : 'bound-elsewhere', conversationKey: identity.conversationKey, binding, selectedId };
  }

  // Everything the UI needs, in one compact object (also what is pushed when something changes).
  function getState({ url = null } = {}) {
    const snapshot = live();
    refreshContexts(snapshot);
    const data = store.get();
    const sel = selection.getState();
    return {
      session,
      store: store.info(),
      connection: observer.getState().connection,
      selected: sel.selected ? { workspaceId: sel.selected.workspaceId, origin: sel.selected.origin } : null,
      pending: Boolean(sel.pending),
      workspaces: snapshot.workspaces.map((w) => ({ id: w.id, label: w.label, directory: w.directory || '' })),
      current: describeCurrent(url, snapshot, data),
      bindings: data.bindings.map((b) => viewOf(b, snapshot, data))
    };
  }

  // For modules that write their own records about a workspace (project bindings): the same destination rules, and the
  // same judgement of a recorded workspace, without a second implementation.
  const judge = (identity, recorded) => { const s = live(); return workspaceStatus({ identity, session, connected: s.connected, workspace: s.byId.get(identity.workspaceId), recorded }); };
  return { bind, adopt, update, unbind, reassign, list, all, listOrphans, lookup, describeCurrent, getState, verifyTarget: checkTarget, judge };
}

module.exports = { createChatBindings };
