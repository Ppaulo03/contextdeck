'use strict';

const { parseProjectUrl } = require('../chat/project-identity');
const { parseChatUrl } = require('../chat/conversation-identity');

// Creation of a conversation inside a workspace's Project (M01-I3B-3). Plain Node.
//
// "+ Nova conversa" in a workspace that has a Project opens the Project's page in a NEW temporary view scoped to that
// workspace. The user then writes the first message in ChatGPT itself (nothing is sent or typed by ContextDeck). The
// conversation is bound to the workspace only when ALL of this holds when its id appears:
//   * the intent is still alive: same view, still scoped to the workspace it was started for, not destroyed;
//   * the workspace selected now is still the one captured at the click (and no switch is pending);
//   * the workspace's ProjectBinding is the very record used at the click (same Project, not edited or replaced);
//   * the page shows a durable conversation whose URL is inside THAT Project (the route carries the Project id);
//   * the normal I3A bind accepts it (destination explicit, no conflict, workspace not suspect...).
// Anything else drops the intent and leaves the page as a temporary conversation of the workspace (recoverable, nothing
// lost, nothing bound); an outcome code says why. There is no retry and no "closest match": the principle is that the app
// may help to associate contexts, never invent the association.
//
// The intent is transient state of this module (never persisted: after a restart the view is gone anyway). It does not
// write bindings through the navigator; it uses the chat bindings service like every other writer.
//
// `evidence(viewId) -> boolean` is the hook for such a sign. None is wired in production (nothing has been verified), so today
// every Project conversation ends as 'unconfirmed-origin': the page stays where it is, flagged, and the user binds it
// explicitly with "Vincular conversa atual".
function createProjectCreation({ session, navigator, bindings, projects, selection, enabled = true, evidence = null }) {
  const intents = new Map();           // viewId -> intent
  const outcomes = new Map();          // viewId -> { code, at }  (what happened to the last intent of that view)
  let resolving = false;
  let seq = 0;

  const wsIdOf = (workspaceKey) => (typeof workspaceKey === 'string' && workspaceKey.startsWith(`${session}/`) ? workspaceKey.slice(session.length + 1) : null);
  const selectedId = () => { const s = selection.getState(); return s.selected && !s.pending ? s.selected.workspaceId : null; };
  // Outcomes after which the page can no longer be presented as the workspace's: it is released to "Sem workspace" (same view,
  // draft and activity) so it stays reachable. The others keep it in the workspace it was started for, flagged with a note.
  const RELEASE = new Set(['context-changed', 'project-changed', 'outside-project', 'navigated-away', 'already-bound']);
  const NOTES = {
    'unconfirmed-origin': 'Conversa do Project deste workspace, mas nada comprova que foi criada agora (pode ser uma conversa antiga). Para vincula-la, use Gerenciar > Vincular conversa atual.'
  };
  const finish = (viewId, code) => {
    intents.delete(viewId);
    outcomes.set(viewId, { code, at: seq++ });
    if (outcomes.size > 50) outcomes.delete(outcomes.keys().next().value);
    if (RELEASE.has(code)) navigator.releaseToUnbound(viewId);
  };

  // The click on "Nova conversa". Without a usable Project the behaviour is exactly the one of before.
  function start({ workspaceKey } = {}) {
    const workspaceId = wsIdOf(workspaceKey);
    const record = enabled && workspaceId ? projects.forWorkspace({ session, workspaceId }) : null;
    if (!record) return navigator.newConversation({ workspaceKey });
    if (record.status !== 'linked') {
      // A Project of a workspace that cannot be verified is not used silently; the plain flow still works.
      const r = navigator.newConversation({ workspaceKey });
      return r.ok ? { ...r, project: null, note: `project-${record.status}` } : r;
    }
    // A second click while the first conversation is still waiting for its id shows that one: no second page.
    for (const intent of intents.values()) {
      if (intent.workspaceId === workspaceId && intent.projectId === record.projectId) {
        const v = navigator.viewInfo(intent.viewId);
        if (v && v.page !== 'destroyed' && v.identity.state !== 'durable') {
          const again = navigator.selectTemporary({ viewId: intent.viewId, workspaceKey });
          return again.ok ? { ...again, project: { projectId: record.projectId, label: record.label }, reused: true } : again;
        }
      }
    }
    const r = navigator.newConversation({ workspaceKey, entryUrl: record.url });
    if (!r.ok) return r;
    intents.set(r.viewId, { viewId: r.viewId, workspaceId, workspaceKey, projectId: record.projectId, projectUpdatedAt: record.updatedAt });
    outcomes.delete(r.viewId);
    return { ...r, project: { projectId: record.projectId, label: record.label }, entry: 'project-page' };
  }

  function evaluate(intent) {
    const v = navigator.viewInfo(intent.viewId);
    if (!v || v.page === 'destroyed') return 'view-closed';
    if (v.scope !== intent.workspaceKey) return 'view-moved';
    if (selectedId() !== intent.workspaceId) return 'context-changed';
    const record = projects.forWorkspace({ session, workspaceId: intent.workspaceId });
    if (!record || record.projectId !== intent.projectId || record.updatedAt !== intent.projectUpdatedAt || record.status !== 'linked') return 'project-changed';
    const id = v.identity;
    if (id.state === 'other') return 'navigated-away';
    if (id.state !== 'durable') return null;                       // still on the Project page / new chat: keep waiting
    const inProject = parseProjectUrl(id.url);
    if (!inProject.ok || inProject.source !== 'project-conversation' || inProject.projectId !== intent.projectId) return 'outside-project';
    const existing = bindings.lookup(id.url);
    if (existing) return 'already-bound';
    // Identifying the Project is NOT proving that this conversation was created now. Observed routes (docs/validation/m01-i3b-3.md):
    // a conversation created from the Project page and an old conversation picked in the sidebar have the same URL shape, and the
    // Project page itself has the same URL before and after "new chat". Without an independent, passive, verified sign of a first
    // send, the association is left to the user.
    if (!(evidence && evidence(intent.viewId) === true)) return 'unconfirmed-origin';
    const result = bindings.bind({
      target: { session, workspaceId: intent.workspaceId },
      url: parseChatUrl(id.url).url,
      origin: 'project-new',
      selectedAtOpen: intent.workspaceId
    });
    if (!result.ok) return `refused:${result.error.code}`;
    return 'bound';
  }

  // Called when the pages or the selection changed. Cheap: it only looks at the pending intents.
  function resolve() {
    if (resolving || !intents.size) return;
    resolving = true;
    try {
      let bound = false;
      for (const intent of [...intents.values()]) {
        const code = evaluate(intent);
        if (code === null) continue;
        finish(intent.viewId, code);
        if (code === 'bound') bound = true;
      }
      if (bound) navigator.reconcile();
    } finally { resolving = false; }
  }

  return {
    start, resolve,
    getOutcome: (viewId) => outcomes.get(viewId) || null,
    // Why a page that stayed in its workspace was not bound (shown on its tab).
    noteFor: (viewId) => { const o = outcomes.get(viewId); return o ? (NOTES[o.code] || (o.code.startsWith('refused:') ? 'Nao foi vinculada automaticamente (' + o.code.slice(8) + '). Use Gerenciar > Vincular conversa atual.' : '')) : ''; },
    pending: () => [...intents.values()].map((i) => ({ viewId: i.viewId, workspaceId: i.workspaceId, projectId: i.projectId })),
    // The user (or a closed view) ends the intent without a result.
    cancel: (viewId) => { if (intents.has(viewId)) finish(viewId, 'cancelled'); }
  };
}

module.exports = { createProjectCreation };
