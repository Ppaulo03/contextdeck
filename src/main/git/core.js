'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveExecutable } = require('../platform/executable');

const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
const TIMEOUT_MS = 60_000;
const MAX_STDERR_BYTES = 64 * 1024;
// Letters, digits and the punctuation of refs like origin/dev, v1.0, HEAD~2, HEAD^, HEAD@{1}.
// No leading "-" (option injection), no whitespace, no ":" (blob paths) and no ".." ranges.
const REF_RE = /^[A-Za-z0-9_./~^@{}-]{1,200}$/;
// Variables that would redirect git away from the directory we validated.
const REDIRECT_VARS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_NAMESPACE', 'GIT_CEILING_DIRECTORIES'];
// Read-only hygiene: never take optional locks (git diff would otherwise refresh the index),
// never prompt, and never run a repository-configured fsmonitor hook.
const BASE_ARGS = ['--no-pager', '-c', 'core.fsmonitor=false'];

function isSafeRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref) && !ref.startsWith('-') && !ref.includes('..');
}

function gitEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !REDIRECT_VARS.includes(key.toUpperCase())) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_TERMINAL_PROMPT = '0';
  return env;
}

// Runs git with an argument array (never a shell). Resolves, never rejects:
// { code, stdout: Buffer, stderr: string, tooLarge, timedOut, spawnError }
function runGit(cwd, args, { maxBytes = MAX_OUTPUT_BYTES, timeoutMs = TIMEOUT_MS, env = process.env } = {}) {
  return new Promise((resolve) => {
    const gitPath = resolveExecutable('git.exe', env);
    if (!gitPath) return resolve({ code: -1, stdout: Buffer.alloc(0), stderr: '', spawnError: 'Git nao encontrado no PATH.' });
    const child = spawn(gitPath, [...BASE_ARGS, ...args], { cwd, env: gitEnv(env), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let outBytes = 0;
    let errText = '';
    let tooLarge = false;
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(out), stderr: errText, tooLarge, timedOut, ...result });
    };
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) { tooLarge = true; child.kill(); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (errText.length < MAX_STDERR_BYTES) errText += chunk.toString('utf8'); });
    child.on('error', (error) => finish({ code: -1, spawnError: error.message }));
    child.on('close', (code) => finish({ code: code ?? -1 }));
  });
}

function describeFailure(result, fallback) {
  if (result.spawnError) return result.spawnError;
  if (result.timedOut) return 'Tempo limite do Git excedido.';
  if (result.tooLarge) return `Saida do Git acima de ${MAX_OUTPUT_BYTES / 1024 / 1024} MB; nada foi copiado.`;
  const detail = result.stderr.trim().split(/\r?\n/)[0];
  return detail ? `${fallback}: ${detail}` : fallback;
}

// Validates that `dir` is an existing directory inside a Git work tree and returns its root.
async function resolveRepoRoot(dir) {
  if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: 'Repositorio nao configurado.' };
  if (!path.isAbsolute(dir)) return { ok: false, error: 'O caminho do repositorio deve ser absoluto.' };
  try {
    if (!fs.statSync(dir).isDirectory()) return { ok: false, error: 'O caminho informado nao e uma pasta.' };
  } catch {
    return { ok: false, error: 'Pasta do repositorio nao encontrada.' };
  }
  const result = await runGit(dir, ['rev-parse', '--show-toplevel'], { maxBytes: 64 * 1024 });
  if (result.spawnError) return { ok: false, error: result.spawnError };
  const top = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !top) return { ok: false, error: 'A pasta nao pertence a um repositorio Git.' };
  return { ok: true, root: path.resolve(top) };
}

// Resolves a user-provided ref to a full commit hash. The hash, not the user's text, is what
// later commands receive.
async function resolveCommit(root, ref) {
  if (!isSafeRef(ref)) return { ok: false, error: `Referencia invalida: "${String(ref).slice(0, 40)}".` };
  const result = await runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { maxBytes: 4096 });
  if (result.spawnError) return { ok: false, error: result.spawnError };
  const sha = result.stdout.toString('utf8').trim();
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, error: `Referencia "${ref}" nao existe neste repositorio.` };
  return { ok: true, sha };
}

// Short hash and subject of a resolved commit, for messages and the revision indicator.
async function describeCommit(root, sha) {
  const result = await runGit(root, ['log', '-1', '--no-color', '--format=%h%x09%s', sha], { maxBytes: 64 * 1024 });
  if (result.code !== 0) return { short: sha.slice(0, 7), subject: '' };
  const [short, ...rest] = result.stdout.toString('utf8').trim().split('\t');
  return { short, subject: rest.join('\t').slice(0, 200) };
}

// kind: 'diff' (working tree vs commit, tracked files only) or 'show'.
async function gitText(root, kind, sha) {
  const args = kind === 'diff'
    ? ['diff', '--no-ext-diff', '--no-color', sha, '--']
    : ['show', '--no-ext-diff', '--no-color', sha, '--'];
  const result = await runGit(root, args);
  if (result.code !== 0 || result.tooLarge || result.timedOut || result.spawnError) {
    return { ok: false, error: describeFailure(result, `git ${kind} falhou`) };
  }
  return { ok: true, text: result.stdout.toString('utf8') };
}

async function gitArchive(root, sha, outFile) {
  const result = await runGit(root, ['archive', '--format=zip', `--output=${outFile}`, sha], { maxBytes: 64 * 1024 });
  if (result.code !== 0 || result.timedOut || result.spawnError) {
    return { ok: false, error: describeFailure(result, 'git archive falhou') };
  }
  return { ok: true };
}

module.exports = { isSafeRef, runGit, resolveRepoRoot, resolveCommit, describeCommit, gitText, gitArchive };
