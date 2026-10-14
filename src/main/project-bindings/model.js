'use strict';

const { parseProjectUrl } = require('../chat/project-identity');
const { validWorkspaceIdentity, sameWorkspace, normalizeLabel, migrate, quarantineEntry } = require('../chat-bindings/model');

// Persistent model of the Project bindings (M01-I3B-3). Pure: no fs, no Electron, no navigation.
//
//   ProjectBinding  "the ChatGPT Project this workspace starts new conversations in" - at most one per workspace and one
//                   workspace per Project. It is NOT a ChatBinding: it says nothing about any existing conversation.
//
// File `project-bindings.json` (schema 1), written with the same atomic/corruption policies as chat-bindings.json:
//   { schema: 1,
//     records:    [ { workspaceIdentity: { session, workspaceId },
//                     workspace: { label, directory, seenAt },        // recovery metadata, same meaning as in chat bindings
//                     projectId, url, label, createdAt, updatedAt } ],
//     quarantine: [ { reason, raw, at } ] }
// Only durable facts. No credentials, no cookies, no page content. The Project NAME is a label the user can edit (its default
// comes from the URL slug); the identity is `projectId`, which must be exactly what the stored url parses to.

const SCHEMA_VERSION = 1;
const LIMITS = Object.freeze({ records: 100, quarantine: 50, directory: 1000 });

const emptyData = () => ({ schema: SCHEMA_VERSION, records: [], quarantine: [] });
const finiteTime = (v) => Number.isFinite(v) && v >= 0 && v < 8.64e15;
const shortText = (v, max) => (typeof v === 'string' && v.length <= max && !v.includes('\0') ? v : '');

function validateRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not-an-object' };
  if (!validWorkspaceIdentity(raw.workspaceIdentity)) return { ok: false, reason: 'bad-workspace-identity' };
  const parsed = parseProjectUrl(raw.url);
  if (!parsed.ok) return { ok: false, reason: 'bad-url' };
  if (raw.projectId !== parsed.projectId) return { ok: false, reason: 'id-url-mismatch' };
  const label = normalizeLabel(raw.label);
  if (!label.ok) return { ok: false, reason: 'bad-label' };
  if (!finiteTime(raw.createdAt) || !finiteTime(raw.updatedAt)) return { ok: false, reason: 'bad-time' };
  const w = raw.workspace && typeof raw.workspace === 'object' ? raw.workspace : {};
  return {
    ok: true,
    record: {
      workspaceIdentity: { session: raw.workspaceIdentity.session, workspaceId: raw.workspaceIdentity.workspaceId },
      workspace: { label: shortText(w.label, 200), directory: shortText(w.directory, LIMITS.directory), seenAt: finiteTime(w.seenAt) ? Math.trunc(w.seenAt) : 0 },
      projectId: parsed.projectId,
      url: parsed.url,
      label: label.label,
      createdAt: Math.trunc(raw.createdAt),
      updatedAt: Math.trunc(raw.updatedAt)
    }
  };
}

// Valid records are kept; invalid ones (and a second record for the same workspace or Project) go to `quarantine`,
// never silently dropped.
function sanitizeData(value, now = Date.now()) {
  const data = emptyData();
  const rejected = [];
  const input = value && typeof value === 'object' ? value : {};
  const byWorkspace = new Set();
  const byProject = new Set();
  for (const raw of Array.isArray(input.records) ? input.records : []) {
    const checked = validateRecord(raw);
    if (!checked.ok) { rejected.push(quarantineEntry(checked.reason, raw, now)); continue; }
    const r = checked.record;
    const wk = `${r.workspaceIdentity.session}/${r.workspaceIdentity.workspaceId}`;
    if (byWorkspace.has(wk)) { rejected.push(quarantineEntry('duplicate-workspace', raw, now)); continue; }
    if (byProject.has(r.projectId)) { rejected.push(quarantineEntry('duplicate-project', raw, now)); continue; }
    byWorkspace.add(wk);
    byProject.add(r.projectId);
    data.records.push(r);
  }
  const previous = (Array.isArray(input.quarantine) ? input.quarantine : []).filter((q) => q && typeof q.reason === 'string' && typeof q.raw === 'string')
    .map((q) => ({ reason: shortText(q.reason, 60), raw: shortText(q.raw, 2000), at: finiteTime(q.at) ? q.at : 0 }));
  data.quarantine = [...previous, ...rejected].slice(-LIMITS.quarantine);
  return { data, rejected: rejected.length };
}

module.exports = { SCHEMA_VERSION, LIMITS, emptyData, validateRecord, sanitizeData, migrate, sameWorkspace };
