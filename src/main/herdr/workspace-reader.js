'use strict';

const { HerdrApiError } = require('./api-client');

// Protocol version this reader was verified against (Herdr 0.9.3). Other versions are read but flagged.
const TESTED_PROTOCOL = 22;

// Reads the authoritative workspace state with one `session.snapshot` call and normalizes it into
// the app's own contract. Herdr's ids are kept verbatim (opaque, stable handles such as "w2").
//
// Internal model:
// {
//   session, serverVersion, protocol, compatibility: 'tested' | 'untested', syncedAt,
//   sessionFocus: { workspaceId, tabId, paneId } | null,   // LAST focus change in the session, from ANY client
//   workspaces: [{ id, number, label, directory, directorySource, activeTabId, tabCount, paneCount,
//                  agentStatus, sessionFocused, worktree }]
// }
// `sessionFocus` is deliberately NOT called "active workspace": see identifyActiveWorkspace().

const str = (v) => (typeof v === 'string' && v ? v : null);

function directoryOf(workspace, panes) {
  const inActiveTab = panes.filter((p) => p.workspace_id === workspace.workspace_id && p.tab_id === workspace.active_tab_id);
  const pane = inActiveTab.find((p) => p.focused && str(p.cwd)) || inActiveTab.find((p) => str(p.cwd));
  return pane ? { directory: str(pane.cwd), directorySource: 'active_tab_pane_cwd' } : { directory: null, directorySource: null };
}

function normalizeSnapshot(raw, { session, now = () => Date.now() } = {}) {
  const snapshot = raw && raw.snapshot;
  if (!snapshot || !Array.isArray(snapshot.workspaces)) {
    throw new HerdrApiError('unexpected_response', 'session.snapshot did not return a workspace list');
  }
  const panes = Array.isArray(snapshot.panes) ? snapshot.panes : [];
  const workspaces = snapshot.workspaces
    .filter((w) => w && typeof w.workspace_id === 'string')
    .map((w) => ({
      id: w.workspace_id,
      number: Number.isInteger(w.number) ? w.number : null,
      label: typeof w.label === 'string' ? w.label : '',
      ...directoryOf(w, panes),
      activeTabId: str(w.active_tab_id),
      tabCount: Number.isInteger(w.tab_count) ? w.tab_count : null,
      paneCount: Number.isInteger(w.pane_count) ? w.pane_count : null,
      agentStatus: str(w.agent_status) || 'unknown',
      sessionFocused: w.focused === true,
      worktree: w.worktree && typeof w.worktree === 'object' ? w.worktree : null
    }));
  const hasFocus = str(snapshot.focused_workspace_id);
  return {
    session: session || null,
    serverVersion: str(snapshot.version),
    protocol: Number.isInteger(snapshot.protocol) ? snapshot.protocol : null,
    compatibility: snapshot.protocol === TESTED_PROTOCOL ? 'tested' : 'untested',
    syncedAt: now(),
    sessionFocus: hasFocus
      ? { workspaceId: snapshot.focused_workspace_id, tabId: str(snapshot.focused_tab_id), paneId: str(snapshot.focused_pane_id) }
      : null,
    workspaces
  };
}

async function readWorkspaces(api, options) {
  return normalizeSnapshot(await api.request('session.snapshot'), options);
}

// Which workspace is visible in ContextDeck's own Herdr client?
//
// Investigation result (docs/validation/m01-i1.md): Herdr's public API has NO per-client focus.
// `focused_workspace_id` and the `workspace_focused` events report the last focus change made by
// *any* client (or the API); with two clients on one session their views diverge while the API
// keeps reporting only the last mover. Therefore:
//   - known:     only when the answer is forced (exactly one workspace exists, so the client must show it);
//   - ambiguous: several workspaces; the session focus is returned as `candidate` and is only a hint;
//   - unknown:   no usable data (disconnected, never synced, or no workspaces).
// No TUI parsing and no "last event wins" assumption is ever promoted to `known`.
function identifyActiveWorkspace(model) {
  if (!model) return { status: 'unknown', workspaceId: null, candidateId: null, evidence: 'none', reason: 'no_data' };
  if (model.workspaces.length === 0) return { status: 'unknown', workspaceId: null, candidateId: null, evidence: 'none', reason: 'no_workspaces' };
  if (model.workspaces.length === 1) {
    return { status: 'known', workspaceId: model.workspaces[0].id, candidateId: null, evidence: 'only_workspace', reason: 'single_workspace_in_session' };
  }
  const candidate = model.sessionFocus && model.workspaces.some((w) => w.id === model.sessionFocus.workspaceId) ? model.sessionFocus.workspaceId : null;
  return { status: 'ambiguous', workspaceId: null, candidateId: candidate, evidence: candidate ? 'session_focus_last_writer' : 'none', reason: 'api_has_no_per_client_focus' };
}

module.exports = { normalizeSnapshot, readWorkspaces, identifyActiveWorkspace, TESTED_PROTOCOL };
