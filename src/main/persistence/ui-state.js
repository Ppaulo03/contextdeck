'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSafeRef } = require('../git/core');
const { WORKSPACE_ID_RE } = require('../herdr/api-client');

const MODES = new Set(['terminal', 'chat']);
const MAX_REPOS = 50;
const MAX_WORKSPACE_REPOS = 100;
const recovery = new WeakMap();

// Identity of a repository for preferences: its resolved root, case-folded (Windows paths).
function repoKey(root) {
  return typeof root === 'string' && root ? path.resolve(root).toLowerCase() : undefined;
}

function pathOrUndefined(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !value.includes('\0') ? value : undefined;
}

function sanitizeRepoPrefs(value) {
  const p = value && typeof value === 'object' ? value : {};
  return {
    baseRef: isSafeRef(p.baseRef) ? p.baseRef : undefined,
    revision: isSafeRef(p.revision) ? p.revision : undefined
  };
}

// git.repos holds per-repository refs keyed by repoKey(); keeping them in one record per
// repository makes it easy to attach them to a future workspace. Files written by M00-I2
// (global baseRef/revision next to repoDir) are migrated into the entry of that repoDir.
function sanitizeGit(value) {
  const g = value && typeof value === 'object' ? value : {};
  const repos = {};
  if (g.repos && typeof g.repos === 'object' && !Array.isArray(g.repos)) {
    for (const [key, prefs] of Object.entries(g.repos).slice(0, MAX_REPOS)) {
      if (key.length > 0 && key.length <= 1000) repos[key] = sanitizeRepoPrefs(prefs);
    }
  }
  const repoDir = pathOrUndefined(g.repoDir);
  const workspaceRepos = {};
  if (g.workspaceRepos && typeof g.workspaceRepos === 'object' && !Array.isArray(g.workspaceRepos)) {
    for (const [key, record] of Object.entries(g.workspaceRepos).slice(0, MAX_WORKSPACE_REPOS)) {
      if (key.length > 0 && key.length <= 512 && record && typeof record === 'object') {
        const root = pathOrUndefined(record.root);
        const label = typeof record.label === 'string' && record.label.length <= 200 ? record.label : undefined;
        const directory = pathOrUndefined(record.directory);
        if (root && label && directory) workspaceRepos[key] = { root, label, directory };
      }
    }
  }
  const legacyKey = repoKey(repoDir);
  if (legacyKey && !repos[legacyKey] && (g.baseRef !== undefined || g.revision !== undefined)) {
    repos[legacyKey] = sanitizeRepoPrefs({ baseRef: g.baseRef, revision: g.revision });
  }
  return { repoDir, lastZip: pathOrUndefined(g.lastZip), repos, workspaceRepos };
}

function workspaceRepoKey(session, workspace) {
  if (typeof session !== 'string' || !workspace || typeof workspace.workspaceId !== 'string' || !workspace.label || !workspace.directory) return undefined;
  return JSON.stringify([session, workspace.workspaceId, workspace.label, path.resolve(workspace.directory).toLowerCase()]);
}

// Herdr workspace selector (M01-I2): sync mode and the last workspace the user picked *explicitly*
// (never an inferred one), bound to the session it belongs to.
function sanitizeHerdr(value) {
  const h = value && typeof value === 'object' ? value : {};
  const last = h.lastWorkspace;
  const valid = last && typeof last === 'object' && typeof last.session === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(last.session) &&
    typeof last.workspaceId === 'string' && WORKSPACE_ID_RE.test(last.workspaceId);
  return {
    mode: h.mode === 'manual' ? 'manual' : 'auto',
    lastWorkspace: valid ? { session: last.session, workspaceId: last.workspaceId } : null
  };
}

// Last conversation the user explicitly chose per workspace (M01-I3B-1): "<session>/<workspaceId>" -> bindingId.
// Only the id of a binding (the bindings themselves live in chat-bindings.json). Bounded; anything malformed is dropped.
const MAX_LAST_CHATS = 100;
const WORKSPACE_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}\/[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const BINDING_ID_RE = /^b_[0-9a-f]{16}$/;
function sanitizeChat(value) {
  const last = {};
  const input = value && typeof value === 'object' && value.last && typeof value.last === 'object' && !Array.isArray(value.last) ? value.last : {};
  for (const [key, id] of Object.entries(input).slice(0, MAX_LAST_CHATS)) {
    if (WORKSPACE_KEY_RE.test(key) && typeof id === 'string' && BINDING_ID_RE.test(id)) last[key] = id;
  }
  return { last };
}

// Only non-sensitive UI preferences live here (last tab, window size, git and workspace settings).
// Credentials and cookies stay inside Chromium's own partition storage.
function sanitize(value) {
  const state = { lastMode: 'terminal', bounds: undefined, git: sanitizeGit(undefined), herdr: sanitizeHerdr(undefined), chat: sanitizeChat(undefined) };
  if (!value || typeof value !== 'object') return state;
  if (MODES.has(value.lastMode)) state.lastMode = value.lastMode;
  const b = value.bounds;
  if (b && Number.isInteger(b.width) && Number.isInteger(b.height) &&
      b.width >= 800 && b.height >= 480 && b.width <= 10000 && b.height <= 10000) {
    state.bounds = { width: b.width, height: b.height };
  }
  state.git = sanitizeGit(value.git);
  state.herdr = sanitizeHerdr(value.herdr);
  state.chat = sanitizeChat(value.chat);
  return state;
}

function getRepoPrefs(state, root) {
  return state.git.repos[repoKey(root)] || { baseRef: undefined, revision: undefined };
}

function setRepoPref(state, root, name, value) {
  const key = repoKey(root);
  if (!key || (name !== 'baseRef' && name !== 'revision') || !isSafeRef(value)) return false;
  if (!state.git.repos[key] && Object.keys(state.git.repos).length >= MAX_REPOS) {
    delete state.git.repos[Object.keys(state.git.repos)[0]]; // Drop the oldest entry.
  }
  state.git.repos[key] = { ...(state.git.repos[key] || {}), [name]: value };
  return true;
}

function loadUiState(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    const state = sanitize(undefined);
    if (!error || error.code !== 'ENOENT') recovery.set(state, { writable: false });
    return state;
  }
  try { return sanitize(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)); }
  catch {
    const backup = `${file}.corrupt-${Date.now()}`;
    let preserved = false;
    try { fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL); preserved = true; } catch { /* Keep original and remain read-only. */ }
    const state = sanitize(undefined);
    recovery.set(state, { writable: preserved, backup: preserved ? backup : null });
    return state;
  }
}

function saveUiState(file, state) {
  const status = state && recovery.get(state);
  if (status && !status.writable) return false;
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(sanitize(state)), { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* Best effort. */ }
    return false; // Best-effort preference; never block shutdown.
  }
}

module.exports = { loadUiState, saveUiState, sanitize, repoKey, workspaceRepoKey, getRepoPrefs, setRepoPref };
