'use strict';

const git = require('./git');
const refsLib = require('./git-refs');
const { repoKey, getRepoPrefs, setRepoPref } = require('./ui-state');

// Active-repository logic shared by every Git IPC handler. `state` is the live ui-state object,
// `persist()` saves it. Every operation re-resolves the repository and every ref here, in the
// main process, so a stale or tampered renderer cannot act on another repository's refs.
function createGitContext({ state, persist, suggestedDir }) {
  const effectiveDir = () => state.git.repoDir || suggestedDir;

  async function activeRepo(expectedRoot) {
    const dir = effectiveDir();
    const repo = await git.resolveRepoRoot(dir);
    if (!repo.ok) return repo;
    if (expectedRoot !== undefined && repoKey(expectedRoot) !== repoKey(repo.root)) {
      return { ok: false, stale: true, error: 'O repositorio ativo mudou; as referencias foram atualizadas. Tente de novo.' };
    }
    return { ok: true, root: repo.root, suggested: !state.git.repoDir };
  }

  // Discovery plus the validated selection for the active repository (pickers' data source).
  async function loadRefs() {
    const repo = await activeRepo();
    if (!repo.ok) return repo;
    const refs = await refsLib.discoverRefs(repo.root);
    const selection = await refsLib.resolveSelection(repo.root, refs, getRepoPrefs(state, repo.root));
    return { ok: true, root: repo.root, suggested: repo.suggested, refs, selection };
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

  return { effectiveDir, activeRepo, loadRefs, setRefs };
}

module.exports = { createGitContext };
