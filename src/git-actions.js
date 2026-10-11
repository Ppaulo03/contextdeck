'use strict';

const fs = require('node:fs');
const path = require('node:path');
const git = require('./git');
const { newZipName, deleteManagedZip } = require('./artifacts');

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// Orchestrates the Git tools. `clipboard` is injected ({ writeText(text), writeFile(path) -> Promise<{ok,error?}>})
// so failures can be tested; every method resolves to { ok, message|error } and never throws.
// Nothing here writes to the repository: git runs read-only and ZIPs go to `artifactsDir`.
function createGitActions({ artifactsDir, clipboard }) {
  async function inspectRepo(dir) {
    const repo = await git.resolveRepoRoot(dir);
    if (!repo.ok) return repo;
    return { ok: true, root: repo.root, name: path.basename(repo.root) };
  }

  async function copyText(kind, repoDir, ref, label) {
    const repo = await git.resolveRepoRoot(repoDir);
    if (!repo.ok) return repo;
    const commit = await git.resolveCommit(repo.root, ref);
    if (!commit.ok) return commit;
    const result = await git.gitText(repo.root, kind, commit.sha);
    if (!result.ok) return result;
    if (!result.text.trim()) {
      return { ok: false, empty: true, error: kind === 'diff'
        ? `Diff vazio em relacao a "${ref}" (arquivos nao rastreados nao entram). Clipboard preservado.`
        : `git show ${ref} nao produziu saida. Clipboard preservado.` };
    }
    try { clipboard.writeText(result.text); } catch (error) { return { ok: false, error: `Falha no clipboard: ${error.message}` }; }
    const info = await git.describeCommit(repo.root, commit.sha);
    return { ok: true, message: `${label} copiado (${formatSize(Buffer.byteLength(result.text))}) — ${path.basename(repo.root)} @ ${ref} = ${info.short} ${info.subject}`.trim() };
  }

  const copyDiff = (repoDir, baseRef) => copyText('diff', repoDir, baseRef, 'git diff');
  const copyShow = (repoDir, revision) => copyText('show', repoDir, revision, 'git show');

  async function makeZip(repoDir, revision) {
    const repo = await git.resolveRepoRoot(repoDir);
    if (!repo.ok) return repo;
    const commit = await git.resolveCommit(repo.root, revision);
    if (!commit.ok) return commit;
    const rel = path.relative(repo.root, artifactsDir);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
      return { ok: false, error: 'O diretorio de artefatos nao pode ficar dentro do repositorio.' };
    }
    try { fs.mkdirSync(artifactsDir, { recursive: true }); } catch (error) { return { ok: false, error: `Nao foi possivel criar a pasta de ZIPs: ${error.message}` }; }
    const file = path.join(artifactsDir, newZipName(path.basename(repo.root), commit.sha));
    const archived = await git.gitArchive(repo.root, commit.sha, file);
    if (!archived.ok) {
      try { fs.unlinkSync(file); } catch { /* Partial file may not exist. */ }
      return archived;
    }
    let size;
    try { size = fs.statSync(file).size; } catch { return { ok: false, error: 'O ZIP nao foi criado.' }; }
    const zip = { path: file, name: path.basename(file), size };
    const copied = await clipboard.writeFile(file);
    if (!copied.ok) {
      return { ok: false, zip, error: `ZIP gerado em ${file} (${formatSize(size)}), mas nao foi copiado como arquivo: ${copied.error}` };
    }
    const info = await git.describeCommit(repo.root, commit.sha);
    return { ok: true, zip, message: `ZIP de ${info.short} "${info.subject}" copiado como arquivo: ${zip.name} (${formatSize(size)}). Pasta: ${artifactsDir}` };
  }

  function deleteZip(zipPath) {
    if (!zipPath) return { ok: false, error: 'Nenhum ZIP gerado para excluir.' };
    const result = deleteManagedZip(artifactsDir, zipPath);
    if (result.ok) return { ok: true, message: `ZIP excluido: ${path.basename(zipPath)}.` };
    return result;
  }

  return { inspectRepo, copyDiff, copyShow, makeZip, deleteZip };
}

module.exports = { createGitActions, formatSize };
