'use strict';

// Protocol fixtures for Herdr 0.9.3 (protocol 22), shaped exactly like the responses captured from
// the real server during M01-I1 (see docs/validation/m01-i1.md); paths and labels are sanitized.

const HOME = 'C:\\Users\\user';

const pong = {
  type: 'pong',
  version: '0.9.3',
  protocol: 22,
  capabilities: { live_handoff: false, detached_server_daemon: true, endpoint_protocol_generation: 1, surface_interest: true, health_check: true, ssh_agent_registration: false }
};

function workspace(n, label, extra = {}) {
  return {
    workspace_id: `w${n}`, number: n, label, focused: false, pane_count: 1, tab_count: 1,
    active_tab_id: `w${n}:t1`, agent_status: 'unknown', ...extra
  };
}

function pane(n, cwd, extra = {}) {
  return {
    pane_id: `w${n}:p1`, terminal_id: `term_${n}`, workspace_id: `w${n}`, tab_id: `w${n}:t1`,
    focused: false, cwd, agent_status: 'unknown', scroll: { offset_from_bottom: 0, max_offset_from_bottom: 0, viewport_rows: 38 }, revision: 0, ...extra
  };
}

// workspaces: [[n, label, cwd]], focused: workspace number (or null)
function snapshotResult(workspaces, focused = null, { protocol = 22, version = '0.9.3', extraWorkspace = {} } = {}) {
  const ws = workspaces.map(([n, label]) => workspace(n, label, { focused: n === focused, ...extraWorkspace }));
  const panes = workspaces.map(([n, , cwd]) => pane(n, cwd === undefined ? `${HOME}\\p${n}` : cwd, { focused: n === focused })).filter((p) => p.cwd !== null);
  return {
    type: 'session_snapshot',
    snapshot: {
      version, protocol,
      ...(focused ? { focused_workspace_id: `w${focused}`, focused_tab_id: `w${focused}:t1`, focused_pane_id: `w${focused}:p1` } : {}),
      workspaces: ws,
      tabs: workspaces.map(([n]) => ({ tab_id: `w${n}:t1`, workspace_id: `w${n}`, number: 1, label: '1', focused: n === focused, pane_count: 1, agent_status: 'unknown' })),
      panes, layouts: [], agents: []
    }
  };
}

const events = {
  focused: (n) => ({ event: 'workspace_focused', data: { type: 'workspace_focused', workspace_id: `w${n}` } }),
  renamed: (n, label) => ({ event: 'workspace_renamed', data: { type: 'workspace_renamed', workspace_id: `w${n}`, label } }),
  closed: (n) => ({ event: 'workspace_closed', data: { type: 'workspace_closed', workspace_id: `w${n}` } }),
  created: (n, label) => ({ event: 'workspace_created', data: { type: 'workspace_created', workspace: workspace(n, label) } })
};

module.exports = { HOME, pong, workspace, pane, snapshotResult, events };
