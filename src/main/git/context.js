'use strict';

const git = require('./core');
const refsLib = require('./refs');
const { repoKey, workspaceRepoKey, getRepoPrefs, setRepoPref } = require('../persistence/ui-state');

// Active-repository logic shared by every Git IPC handler. `state` is the live ui-state object,
// `persist()` saves it. Every operation re-resolves the repository and every ref here, in the
// main process, so a stale or tampered renderer cannot act on another repository's refs.
function createGitContext({ state, persist, suggestedDir, selection, session }) {
  function workspace() {
    const selected = selection?.getState?.();
    if (!selected?.selected) return null;
    const option = (selected.options || []).find((item) => item.id === selected.selected.workspaceId);
    if (!option) return null;
    return { workspaceId: option.id, label: option.label, directory: option.directory || '' };
  }

  function choice() {
    const ws = workspace();
    const key = ws && workspaceRepoKey(session, ws);
    const manual = key && state.git.workspaceRepos[key];
    if (manual) return { dir: manual.root, source: 'manual', workspace: ws, key };
    if (state.git.repoDir) return { dir: state.git.repoDir, source: 'manual', workspace: ws, key };
    if (ws?.directory) return { dir: ws.directory, source: 'herdr', workspace: ws, key };
    return { dir: suggestedDir, source: suggestedDir ? 'settings' : null, workspace: ws, key };
  }

  const effectiveDir = () => choice().dir;

  async function activeRepo(expectedRoot) {
    const picked = choice();
    const dir = picked.dir;
    const repo = await git.resolveRepoRoot(dir);
    if (!repo.ok) return repo;
    if (expectedRoot !== undefined && repoKey(expectedRoot) !== repoKey(repo.root)) {
      return { ok: false, stale: true, error: 'O repositorio ativo mudou; as referencias foram atualizadas. Tente de novo.' };
    }
    return { ok: true, root: repo.root, suggested: picked.source === 'herdr', source: picked.source, workspace: picked.workspace };
  }

  // Discovery plus the validated selection for the active repository (pickers' data source).
  async function loadRefs() {
    const repo = await activeRepo();
    if (!repo.ok) return repo;
    const refs = await refsLib.discoverRefs(repo.root);
    const selection = await refsLib.resolveSelection(repo.root, refs, getRepoPrefs(state, repo.root));
    return { ok: true, root: repo.root, suggested: repo.suggested, source: repo.source, refs, selection };
  }

  async function chooseRepo(root, target = choice()) {
    const repo = await git.resolveRepoRoot(root);
    if (!repo.ok) return repo;
    const picked = target;
    if (picked.workspace && picked.key) {
      if (!state.git.workspaceRepos[picked.key] && Object.keys(state.git.workspaceRepos).length >= 100) {
        delete state.git.workspaceRepos[Object.keys(state.git.workspaceRepos)[0]];
      }
      state.git.workspaceRepos[picked.key] = { root: repo.root, label: picked.workspace.label, directory: picked.workspace.directory };
    } else state.git.repoDir = repo.root;
    persist();
    return { ok: true, root: repo.root };
  }

  function useAutomatic() {
    const picked = choice();
    if (picked.key) delete state.git.workspaceRepos[picked.key];
    // An explicit return to automatic mode also clears the pre-workspace global override.
    state.git.repoDir = undefined;
    persist();
    return { ok: true };
  }

  // Validates and stores refs for this repository only. Nothing is stored unless it resolves.
  async function setRefs(expectedRoot, wanted) {
    const repo = await activeRepo(expectedRoot);
    if (!repo.ok) return repo;
    const out = { ok: true };
    const refs = await refsLib.discoverRefs(repo.root);
    for (const [name, key] of [['baseRef', 'base'], ['revision', 'revision']]) {
      if (wanted?.[name] === undefined) continue;
      const selection = await refsLib.describeSelection(repo.root, refs, wanted[name], 'saved');
      if (!selection) {
        const commit = await git.resolveCommit(repo.root, wanted[name]);
        return { ok: false, error: commit.error || `Referencia "${wanted[name]}" invalida.` };
      }
      setRepoPref(state, repo.root, name, wanted[name]);
      out[key] = selection;
    }
    persist();
    return out;
  }

  return { effectiveDir, activeRepo, loadRefs, setRefs, chooseRepo, useAutomatic, workspace, choice };
}

module.exports = { createGitContext };
