'use strict';

// "+ Nova conversa" in a workspace that has a Project (M01-I3B-3). Plain Node.
//
// The click opens the Project's page in a page that lives in the workspace captured at the click (the navigator reuses a page
// that is still waiting, so a double click makes no second view). Nothing is typed or sent by ContextDeck. What happens next
// is the ordinary workspace-first rule (chat-bindings/context-adoption.js): the conversation that shows up in that page - new
// or an old one picked in the sidebar - is bound to the workspace of the click. Whether it also belongs to the Project is NOT
// inferred from the binding, and the ProjectBinding is never modified here.
//
// Without a usable Project (none linked, the feature off, or the workspace is not verified) the behaviour is the plain one.
function createProjectCreation({ session, navigator, projects, enabled = true }) {
  const wsIdOf = (workspaceKey) => (typeof workspaceKey === 'string' && workspaceKey.startsWith(`${session}/`) ? workspaceKey.slice(session.length + 1) : null);

  function start({ workspaceKey } = {}) {
    const workspaceId = wsIdOf(workspaceKey);
    const record = enabled && workspaceId ? projects.forWorkspace({ session, workspaceId }) : null;
    if (!record) return navigator.newConversation({ workspaceKey });
    if (record.status !== 'linked') {
      // A Project of a workspace that cannot be verified is not used silently; the plain flow still works.
      const r = navigator.newConversation({ workspaceKey });
      return r.ok ? { ...r, project: null, note: `project-${record.status}` } : r;
    }
    const r = navigator.newConversation({ workspaceKey, entryUrl: record.url });
    return r.ok ? { ...r, project: { projectId: record.projectId, label: record.label }, entry: 'project-page' } : r;
  }

  return { start };
}

module.exports = { createProjectCreation };
