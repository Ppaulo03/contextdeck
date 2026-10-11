'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isSafeRef } = require('../git/core');

const MODES = new Set(['terminal', 'chat']);
const MAX_REPOS = 50;

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
  const legacyKey = repoKey(repoDir);
  if (legacyKey && !repos[legacyKey] && (g.baseRef !== undefined || g.revision !== undefined)) {
    repos[legacyKey] = sanitizeRepoPrefs({ baseRef: g.baseRef, revision: g.revision });
  }
  return { repoDir, lastZip: pathOrUndefined(g.lastZip), repos };
}

// Only non-sensitive UI preferences live here (last tab, window size, git settings).
// Credentials and cookies stay inside Chromium's own partition storage.
function sanitize(value) {
  const state = { lastMode: 'terminal', bounds: undefined, git: sanitizeGit(undefined) };
  if (!value || typeof value !== 'object') return state;
  if (MODES.has(value.lastMode)) state.lastMode = value.lastMode;
  const b = value.bounds;
  if (b && Number.isInteger(b.width) && Number.isInteger(b.height) &&
      b.width >= 800 && b.height >= 480 && b.width <= 10000 && b.height <= 10000) {
    state.bounds = { width: b.width, height: b.height };
  }
  state.git = sanitizeGit(value.git);
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
  try { return sanitize(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return sanitize(undefined); }
}

function saveUiState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(sanitize(state)), 'utf8');
  } catch { /* Best-effort preference; never block shutdown. */ }
}

module.exports = { loadUiState, saveUiState, sanitize, repoKey, getRepoPrefs, setRepoPref };
