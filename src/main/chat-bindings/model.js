'use strict';

const { parseChatUrl } = require('../chat/conversation-identity');
const { WORKSPACE_ID_RE } = require('../herdr/api-client');

// Persistent model of chat bindings (M01-I3A). Pure: no fs, no Electron, no runtime/observer imports.
//
//   ChatBinding           one conversation attached to one workspace (the unit users edit)
//   WorkspaceChatContext  the set of bindings sharing a workspaceIdentity, plus the recovery metadata of that
//                         workspace (`contexts`): last seen label/directory, used to detect a recreated workspace
//
// File shape (schema 1):
//   { schema: 1,
//     contexts:   { "<session>/<workspaceId>": { session, workspaceId, label, directory, seenAt } },
//     bindings:   [ { bindingId, conversationKey, url, label, role, origin, workspaceIdentity: { session, workspaceId },
//                     createdAt, updatedAt } ],
//     quarantine: [ { reason, raw, at } ] }                // entries that failed validation, kept instead of dropped
//
// Only durable facts live here. No messages, prompts, drafts, cookies, generation/draft/attention state.

const SCHEMA_VERSION = 1;
const ROLES = Object.freeze(['general', 'architecture', 'review', 'planning']);
const ORIGINS = Object.freeze(['current-page', 'url']);
const LIMITS = Object.freeze({ label: 80, bindings: 300, perWorkspace: 40, quarantine: 50, rawQuarantine: 2000, directory: 1000 });

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const BINDING_ID_RE = /^b_[0-9a-f]{16}$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/g;

const err = (code, message, extra) => ({ ok: false, error: { code, message, ...extra } });

// The identity of a workspace context. The session name is part of it because Herdr ids ("w3") are only
// unique inside one session; "/" cannot occur in a session name, so the key is unambiguous.
function validWorkspaceIdentity(value) {
  return Boolean(value) && typeof value === 'object' && typeof value.session === 'string' && SESSION_RE.test(value.session) &&
    typeof value.workspaceId === 'string' && WORKSPACE_ID_RE.test(value.workspaceId);
}
const contextKey = (identity) => `${identity.session}/${identity.workspaceId}`;
const sameWorkspace = (a, b) => Boolean(a && b) && a.session === b.session && a.workspaceId === b.workspaceId;

// User text: control characters removed, whitespace collapsed, never truncated silently.
function normalizeLabel(value) {
  if (value === undefined || value === null) return { ok: true, label: '' };
  if (typeof value !== 'string') return err('invalid_label', 'O rotulo deve ser um texto.');
  const label = value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim();
  if (label.length > LIMITS.label) return err('invalid_label', `O rotulo pode ter no maximo ${LIMITS.label} caracteres.`);
  return { ok: true, label };
}

function normalizeRole(value) {
  if (value === undefined || value === null) return { ok: true, role: 'general' };
  if (typeof value !== 'string' || !ROLES.includes(value)) return err('invalid_role', 'Categoria invalida.');
  return { ok: true, role: value };
}

const finiteTime = (v) => Number.isFinite(v) && v >= 0 && v < 8.64e15;
const shortText = (v, max) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : '');

function emptyData() {
  return { schema: SCHEMA_VERSION, contexts: {}, bindings: [], quarantine: [] };
}

// Strict check of one stored binding. The URL must parse to the very conversationKey stored with it, so a
// hand-edited or damaged file cannot smuggle in a binding whose identity and address disagree.
function validateBinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' };
  if (typeof raw.bindingId !== 'string' || !BINDING_ID_RE.test(raw.bindingId)) return { ok: false, reason: 'bad-binding-id' };
  if (!validWorkspaceIdentity(raw.workspaceIdentity)) return { ok: false, reason: 'bad-workspace-identity' };
  const identity = parseChatUrl(raw.url);
  if (!identity.ok) return { ok: false, reason: 'bad-url' };
  if (raw.conversationKey !== identity.conversationKey) return { ok: false, reason: 'key-url-mismatch' };
  const label = normalizeLabel(raw.label);
  if (!label.ok) return { ok: false, reason: 'bad-label' };
  const role = raw.role === undefined ? { ok: true, role: 'general' } : normalizeRole(raw.role);
  if (!role.ok) return { ok: false, reason: 'bad-role' };
  if (!finiteTime(raw.createdAt) || !finiteTime(raw.updatedAt)) return { ok: false, reason: 'bad-time' };
  return {
    ok: true,
    binding: {
      bindingId: raw.bindingId,
      conversationKey: identity.conversationKey,
      url: identity.url,
      label: label.label,
      role: role.role,
      origin: ORIGINS.includes(raw.origin) ? raw.origin : 'url',
      workspaceIdentity: { session: raw.workspaceIdentity.session, workspaceId: raw.workspaceIdentity.workspaceId },
      createdAt: Math.trunc(raw.createdAt),
      updatedAt: Math.trunc(raw.updatedAt)
    }
  };
}

function sanitizeContext(raw) {
  if (!raw || typeof raw !== 'object' || !validWorkspaceIdentity(raw)) return null;
  return {
    session: raw.session,
    workspaceId: raw.workspaceId,
    label: shortText(raw.label, 200),
    directory: shortText(raw.directory, LIMITS.directory),
    seenAt: finiteTime(raw.seenAt) ? Math.trunc(raw.seenAt) : 0
  };
}

function quarantineEntry(reason, raw, at) {
  let text;
  try { text = JSON.stringify(raw); } catch { text = String(raw); }
  return { reason, raw: String(text).slice(0, LIMITS.rawQuarantine), at };
}

// Validates a parsed document of the current schema. Valid entries are kept; invalid ones are moved to
// `quarantine` (never silently dropped) so a partially damaged file loses nothing the user could recover.
function sanitizeData(value, now = Date.now()) {
  const data = emptyData();
  const rejected = [];
  const input = value && typeof value === 'object' ? value : {};
  const seenKeys = new Set();
  const seenIds = new Set();
  for (const raw of Array.isArray(input.bindings) ? input.bindings : []) {
    const checked = validateBinding(raw);
    if (!checked.ok) { rejected.push(quarantineEntry(checked.reason, raw, now)); continue; }
    const b = checked.binding;
    if (seenKeys.has(b.conversationKey)) { rejected.push(quarantineEntry('duplicate-conversation', raw, now)); continue; }
    if (seenIds.has(b.bindingId)) { rejected.push(quarantineEntry('duplicate-binding-id', raw, now)); continue; }
    seenKeys.add(b.conversationKey);
    seenIds.add(b.bindingId);
    data.bindings.push(b);
  }
  const contexts = input.contexts && typeof input.contexts === 'object' && !Array.isArray(input.contexts) ? input.contexts : {};
  for (const raw of Object.values(contexts)) {
    const c = sanitizeContext(raw);
    if (c) data.contexts[contextKey(c)] = c;
  }
  for (const b of data.bindings) {
    const key = contextKey(b.workspaceIdentity);
    if (!data.contexts[key]) data.contexts[key] = { ...b.workspaceIdentity, label: '', directory: '', seenAt: 0 };
  }
  const previous = (Array.isArray(input.quarantine) ? input.quarantine : []).filter((q) => q && typeof q.reason === 'string' && typeof q.raw === 'string')
    .map((q) => ({ reason: shortText(q.reason, 60), raw: shortText(q.raw, LIMITS.rawQuarantine), at: finiteTime(q.at) ? q.at : 0 }));
  data.quarantine = [...previous, ...rejected].slice(-LIMITS.quarantine);
  return { data, rejected: rejected.length };
}

// Schema migrations: `migrations[n]` upgrades a document of schema n to n + 1. Version 1 is the first schema,
// so the table is empty today; the mechanism (and its refusal of documents from the future) is tested.
const MIGRATIONS = Object.freeze({});

function migrate(doc, { migrations = MIGRATIONS, current = SCHEMA_VERSION } = {}) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || !Number.isInteger(doc.schema) || doc.schema < 1) return { status: 'invalid' };
  if (doc.schema > current) return { status: 'future', schema: doc.schema };
  let out = doc;
  for (let v = doc.schema; v < current; v++) {
    if (typeof migrations[v] !== 'function') return { status: 'invalid', reason: `no migration from ${v}` };
    out = { ...migrations[v](out), schema: v + 1 };
  }
  return { status: 'ok', doc: out, migratedFrom: doc.schema < current ? doc.schema : null };
}

module.exports = {
  SCHEMA_VERSION, ROLES, ORIGINS, LIMITS, SESSION_RE, MIGRATIONS, err,
  validWorkspaceIdentity, contextKey, sameWorkspace, normalizeLabel, normalizeRole,
  emptyData, validateBinding, sanitizeData, migrate, quarantineEntry
};
