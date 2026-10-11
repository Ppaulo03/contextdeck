'use strict';

// Direct navigation from the activity center (M01-I3B-2H): open a conversation of ANY workspace. Plain Node.
//
// It is the user's explicit action and nothing else: the only Herdr write is the existing explicit selection
// (`selection.select` -> workspace.focus, validated by the M01-I2 controller, honouring its rules); status updates never
// get here. Two systems are involved (Herdr and the chat views), so atomicity is NOT pretended: every step is checked
// before the next and a partial outcome is reported as such.
//
//   1. resolve the target against the CURRENT state (the binding exists in that workspace; orphans and other sessions never
//      open; a suspect/unverified binding needs `confirm`) - all before anything is sent;
//   2. if another workspace is selected, ask for the switch and wait for the controller's answer; a failure stops here: the
//      chat tab is NOT shown and no conversation is selected under the wrong context;
//   3. re-check that the user's latest request is still this one and that the selected workspace is the target;
//   4. show the chat tab, then select the conversation through the navigator (it reuses the loaded view and is the visit).
// A newer request supersedes an older one: late answers of the old one change nothing.
function createDirectOpen({ session, selection, navigator, showChatTab, getMode }) {
  let seq = 0;
  const fail = (code, message, extra) => ({ ok: false, error: { code, message, ...extra } });

  async function open({ workspaceId, bindingId, viewId, confirm } = {}) {
    const target = navigator.resolveActivityTarget({ workspaceId, bindingId, viewId });
    if (!target) return fail('target_not_found', 'Esta conversa nao existe mais neste workspace.');
    if (target.kind === 'binding') {
      const status = target.binding.status;
      if (status === 'orphan' || status === 'other-session') return fail('not_available', 'O workspace desta conversa nao esta disponivel.');
      if (status !== 'linked' && confirm !== true) {
        return fail('confirmation_required', status === 'suspect' ? 'A identidade deste workspace nao foi verificada. Confirme para abrir.' : 'O Herdr esta desconectado e o workspace nao pode ser verificado. Confirme para abrir.', { status });
      }
    }

    const current = () => { const s = selection.getState(); return s.selected ? s.selected.workspaceId : null; };
    let switched = false;
    // Only a request that passed every check above and is about to act counts as "the latest": a refused one (a switch
    // already in flight, a target that is gone) must not invalidate the request that is still being served.
    if (current() !== workspaceId && selection.getState().pending) return fail('selection_pending', 'Uma troca de workspace ja esta em andamento.');
    const my = ++seq;
    if (current() !== workspaceId) {
      const result = await selection.select(session, workspaceId);
      if (my !== seq) return { ok: false, superseded: true };
      if (!result || result.ok !== true) {
        if (result && result.stale) return { ok: false, superseded: true };
        const reason = (result && result.error && result.error.message) || 'falha desconhecida';
        return fail((result && result.error && result.error.code) || 'focus_failed', `Nao foi possivel trocar de workspace: ${reason} A conversa nao foi aberta.`, { workspaceChanged: false });
      }
      switched = true;
    }
    if (my !== seq) return { ok: false, superseded: true };
    // The controller may have settled on another workspace (Auto mode followed the observed focus): never show a chat under it.
    if (selection.getState().pending || current() !== workspaceId) {
      return fail('context_changed', 'O Herdr nao confirmou a troca para este workspace. A conversa nao foi aberta.', { workspaceChanged: switched });
    }

    if (getMode() !== 'chat') showChatTab();
    const opened = target.kind === 'binding'
      ? navigator.selectBinding({ bindingId: target.binding.bindingId, workspaceKey: target.wk, confirm: confirm === true })
      : navigator.selectTemporary({ viewId: target.viewId, workspaceKey: target.wk });
    if (!opened.ok) {
      return { ok: false, workspaceChanged: switched, error: { ...opened.error, message: `${opened.error.message}${switched ? ' O workspace foi trocado, mas a conversa nao foi aberta.' : ''}` } };
    }
    return { ok: true, switched, viewId: opened.viewId };
  }

  return { open };
}

module.exports = { createDirectOpen };
