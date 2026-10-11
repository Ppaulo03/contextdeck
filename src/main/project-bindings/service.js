'use strict';

const { parseProjectUrl, labelFromSlug, fallbackLabel } = require('../chat/project-identity');
const { err, normalizeLabel, validWorkspaceIdentity, sameWorkspace } = require('../chat-bindings/model');
const { LIMITS } = require('./model');

// Domain operations of the Project bindings (M01-I3B-3). Plain Node, deterministic, testable without Electron.
//
// A ProjectBinding says "new conversations of this workspace start in this ChatGPT Project". It is a different thing from a
// ChatBinding (a conversation attached to a workspace) and neither implies the other: linking a Project moves, binds, reloads
// and edits nothing that exists.
//
// The write rules are the ones of the chat bindings, not a copy: the destination is verified by the same function
// (`bindings.verifyTarget`: Herdr connected, same session, no switch pending, the selection is the one the form was opened
// with, the workspace exists, and the destination is explicit) and a recorded workspace is judged by the same function
// (`bindings.judge`: linked / suspect / orphan / unverified). On top of that:
//   * one Project per workspace and one workspace per Project; neither is ever replaced or moved silently:
//     `replace` swaps the Project of a workspace, `move` takes a Project away from the workspace that has it;
//   * a workspace whose record is `suspect` (same id, label and directory both changed: a recreated session) can only be
//     written with `replace`, which is the explicit re-confirmation;
//   * the Project is identified by its id, never by its name; the same id with another slug is the same Project (a rename).
function createProjectBindings({ store, session, bindings, observer, selection, now = () => Date.now() }) {
  const clone = (data) => JSON.parse(JSON.stringify(data));
  const same = (a, id) => sameWorkspace(a.workspaceIdentity, id);

  const liveWorkspace = (identity) => {
    const o = observer.getState();
    return o.connection === 'connected' && o.model ? o.model.workspaces.find((w) => w.id === identity.workspaceId) || null : null;
  };

  function viewOf(record) {
    const live = record.workspaceIdentity.session === session ? liveWorkspace(record.workspaceIdentity) : null;
    return {
      ...record,
      workspaceIdentity: { ...record.workspaceIdentity },
      status: bindings.judge(record.workspaceIdentity, record.workspace),
      label: record.label || fallbackLabel(record.projectId),
      workspaceLabel: live ? live.label : record.workspace.label
    };
  }

  function commit(mutate) {
    const draft = clone(store.get());
    const result = mutate(draft);
    if (result && result.ok === false) return result;
    try { store.save(draft); } catch (error) {
      if (error && error.code === 'store_readonly') return err('store_readonly', 'Os vinculos de Projects estao em modo somente leitura (arquivo ilegivel ou de versao mais nova).');
      return err('write_failed', 'Nao foi possivel gravar o vinculo do Project. Nada foi alterado.');
    }
    return result || { ok: true };
  }

  // Re-linking the same Project without a new name keeps the name it already has.
  const mineLabel = (target, projectId) => { const r = store.get().records.find((x) => same(x, target) && x.projectId === projectId); return r ? r.label : ''; };

  function link({ target, url, label, selectedAtOpen, confirmTarget, targetChosen, replace, move } = {}) {
    const parsed = parseProjectUrl(url);
    if (!parsed.ok) return err(parsed.reason.replace(/-/g, '_'), parsed.message);
    const l = normalizeLabel(label === undefined || label === '' ? (labelFromSlug(parsed.slug) || (mineLabel(target, parsed.projectId)) || fallbackLabel(parsed.projectId)) : label);
    if (!l.ok) return l;
    const checked = bindings.verifyTarget(target, { selectedAtOpen, confirmTarget, targetChosen });
    if (!checked.ok) return checked;
    const data = store.get();
    const mine = data.records.find((r) => same(r, target));
    const holder = data.records.find((r) => r.projectId === parsed.projectId && !same(r, target));
    if (holder && move !== true) {
      return err('project_conflict', 'Este Project ja esta vinculado a outro workspace. Mova-o explicitamente se for o caso.', { record: viewOf(holder) });
    }
    if (mine && mine.projectId !== parsed.projectId && replace !== true) {
      return err('project_already_linked', 'Este workspace ja tem outro Project vinculado. Substitua-o explicitamente.', { record: viewOf(mine) });
    }
    if (mine && viewOf(mine).status === 'suspect' && replace !== true) {
      return err('workspace_suspect', 'A identidade deste workspace nao foi verificada (parece ter sido recriado). Confirme explicitamente a substituicao do Project.', { record: viewOf(mine) });
    }
    if (!mine && data.records.length >= LIMITS.records) return err('limit_reached', `Limite de ${LIMITS.records} Projects vinculados atingido.`);
    const stamp = now();
    const record = {
      workspaceIdentity: { session: target.session, workspaceId: target.workspaceId },
      workspace: { label: checked.workspace.label, directory: checked.workspace.directory || '', seenAt: stamp },
      projectId: parsed.projectId,
      url: parsed.url,
      label: l.label,
      createdAt: mine && mine.projectId === parsed.projectId ? mine.createdAt : stamp,
      updatedAt: stamp
    };
    const done = commit((draft) => {
      draft.records = draft.records.filter((r) => !same(r, target) && r.projectId !== parsed.projectId);
      draft.records.push(record);
    });
    if (!done.ok) return done;
    return { ok: true, record: viewOf(record), renamed: Boolean(mine && mine.projectId === parsed.projectId && mine.url !== parsed.url) };
  }

  // Removing the link is explicit and touches nothing else (no conversation, no ChatBinding, nothing in ChatGPT).
  function unlink({ workspaceIdentity } = {}) {
    if (!validWorkspaceIdentity(workspaceIdentity)) return err('invalid_target', 'Destino invalido.');
    if (!store.get().records.some((r) => same(r, workspaceIdentity))) return err('not_found', 'Este workspace nao tem Project vinculado.');
    return commit((draft) => { draft.records = draft.records.filter((r) => !same(r, workspaceIdentity)); });
  }

  const forWorkspace = (identity) => {
    const r = validWorkspaceIdentity(identity) ? store.get().records.find((x) => same(x, identity)) : null;
    return r ? viewOf(r) : null;
  };
  const all = () => store.get().records.map(viewOf);

  // What the UI shows about the page that is loaded now: a Project it could link, or nothing. Never changes anything.
  const describeCurrent = (url) => {
    const p = url ? parseProjectUrl(url) : null;
    if (!p || !p.ok) return null;
    const holder = store.get().records.find((r) => r.projectId === p.projectId);
    return { projectId: p.projectId, url: p.url, label: labelFromSlug(p.slug) || fallbackLabel(p.projectId), source: p.source, linkedTo: holder ? { ...holder.workspaceIdentity } : null };
  };

  const getState = ({ url = null } = {}) => ({ store: store.info(), records: all(), current: describeCurrent(url) });

  return { link, unlink, forWorkspace, all, describeCurrent, getState };
}

module.exports = { createProjectBindings };
