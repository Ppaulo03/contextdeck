'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createGitContext } = require('../git/context');
const { createGitActions, formatSize } = require('../git/actions');
const { copyFileToClipboard } = require('../platform/file-clipboard');
const { ARTIFACTS_DIRNAME } = require('../persistence/identity');

// Git tools: a fixed set of IPC channels, each validating its arguments. There is no generic
// "run command" channel, and nothing here is reachable from the remote ChatGPT page (no preload).
function registerGitIpc({ ipcMain, clipboard, dialog, trusted, win, settings, uiState, persist, userDataDir }) {
  const artifactsDir = path.join(userDataDir, ARTIFACTS_DIRNAME);
  const gitActions = createGitActions({
    artifactsDir,
    clipboard: { writeText: (text) => clipboard.writeText(text), writeFile: copyFileToClipboard }
  });
  const ctx = createGitContext({ state: uiState, persist, suggestedDir: settings.workingDirectory });
  let busy = false;

  function zipInfo() {
    const file = uiState.git.lastZip;
    if (!file) return undefined;
    try {
      const stat = fs.lstatSync(file);
      return stat.isFile() ? { name: path.basename(file), size: stat.size, sizeText: formatSize(stat.size) } : undefined;
    } catch { return undefined; }
  }

  async function status() {
    const dir = ctx.effectiveDir();
    const info = await gitActions.inspectRepo(dir);
    return {
      configured: info.ok,
      root: info.root,
      name: info.name,
      error: info.ok ? undefined : (dir ? info.error : 'Repositorio nao configurado. Use "Repo..." para escolher a pasta.'),
      suggested: info.ok && !uiState.git.repoDir,
      zip: zipInfo()
    };
  }

  // Serializes git operations so two clicks cannot race on the same ZIP/clipboard.
  async function exclusive(task) {
    if (busy) return { ok: false, error: 'Outra operacao Git ainda esta em andamento.' };
    busy = true;
    try { return await task(); } catch (error) { return { ok: false, error: `Erro inesperado: ${error?.message || error}` }; } finally { busy = false; }
  }

  // Every action re-validates in the main process: the renderer only says which repository it
  // was looking at (`repoRoot`) and which ref; both are re-resolved here before git runs.
  async function withActiveRepo(args, run) {
    const repo = await ctx.activeRepo(typeof args?.repoRoot === 'string' ? args.repoRoot : null);
    if (!repo.ok) return repo;
    return run(repo.root);
  }

  const denied = { ok: false, error: 'Untrusted IPC caller' };

  ipcMain.handle('git:status', async (event) => (trusted(event) ? status() : null));
  ipcMain.handle('git:refs', async (event) => (trusted(event) ? ctx.loadRefs() : denied));

  ipcMain.handle('git:pick-repo', async (event) => {
    if (!trusted(event)) return denied;
    const picked = await dialog.showOpenDialog(win.getWindow(), {
      title: 'Escolha a pasta do repositorio Git',
      defaultPath: ctx.effectiveDir(),
      properties: ['openDirectory']
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, cancelled: true };
    const info = await gitActions.inspectRepo(picked.filePaths[0]);
    if (!info.ok) return { ok: false, error: info.error };
    uiState.git.repoDir = info.root;
    persist();
    return { ok: true, message: `Repositorio: ${info.root}` };
  });

  ipcMain.handle('git:set-refs', (event, args) => {
    if (!trusted(event)) return denied;
    return ctx.setRefs(typeof args?.repoRoot === 'string' ? args.repoRoot : null, { baseRef: args?.baseRef, revision: args?.revision });
  });

  ipcMain.handle('git:diff', (event, args) => {
    if (!trusted(event)) return denied;
    return exclusive(() => withActiveRepo(args, (root) => gitActions.copyDiff(root, args?.baseRef)));
  });

  ipcMain.handle('git:show', (event, args) => {
    if (!trusted(event)) return denied;
    return exclusive(() => withActiveRepo(args, (root) => gitActions.copyShow(root, args?.revision)));
  });

  ipcMain.handle('git:zip', (event, args) => {
    if (!trusted(event)) return denied;
    return exclusive(() => withActiveRepo(args, async (root) => {
      const result = await gitActions.makeZip(root, args?.revision);
      // The ZIP exists on disk even if the file-clipboard step failed: keep it selectable/deletable.
      if (result.zip) { uiState.git.lastZip = result.zip.path; persist(); }
      return result;
    }));
  });

  // Takes no path from the renderer: only the ZIP this app generated last can be removed.
  ipcMain.handle('git:delete-zip', (event) => {
    if (!trusted(event)) return denied;
    return exclusive(async () => {
      const result = gitActions.deleteZip(uiState.git.lastZip);
      if (result.ok || result.missing) { uiState.git.lastZip = undefined; persist(); }
      return result;
    });
  });
}

module.exports = { registerGitIpc };
