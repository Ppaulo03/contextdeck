'use strict';

// Pure view-models for the chat bindings (M01-I3A): the top-bar indicator and the bindings panel. No DOM and
// no Electron, so they are unit-tested directly in Node. The state they read is what main pushes as
// `chats:state` (see src/main/chat-bindings/service.js#getState).
//
// Principles: the destination workspace is always shown with its id (names can repeat); an estimated
// destination says so; nothing here decides anything - main re-validates every write.

const ROLE_LABELS = { general: 'Geral', architecture: 'Arquitetura', review: 'Revisão', planning: 'Planejamento' };

const ORIGIN_NOTE = {
  dock: 'escolhido no ContextDeck',
  herdr: 'estimado pelo foco do Herdr',
  recovery: 'restaurado (estimativa)'
};

const STATUS_TEXT = {
  linked: '',
  orphan: 'órfão: o workspace não existe mais',
  suspect: 'identidade do workspace não verificada',
  unverified: 'Herdr desconectado: não verificado',
  'other-session': 'pertence a outra sessão do Herdr'
};

const UNKNOWN_REASON = {
  new: 'Conversa nova, ainda sem identidade persistente. Envie a primeira mensagem para que ela ganhe um endereço próprio.',
  'not-a-conversation': 'Esta página não é uma conversa.',
  'no-page': 'Nenhuma página carregada.',
  'invalid-url': 'Endereço da página não reconhecido.',
  'foreign-host': 'Página fora de chatgpt.com.',
  'insecure-protocol': 'Página sem https.'
};

const wsLabel = (w) => `${w.id} · ${w.label || '(sem nome)'}`;
const findWs = (state, id) => (state && state.workspaces ? state.workspaces.find((w) => w.id === id) : null) || null;
const roleLabel = (role) => ROLE_LABELS[role] || ROLE_LABELS.general;
const displayLabel = (b) => b.label || '(sem rótulo)';

function workspaceName(state, binding) {
  const id = binding.workspaceIdentity.workspaceId;
  const live = findWs(state, id);
  if (live && binding.workspaceIdentity.session === state.session) return wsLabel(live);
  return binding.workspaceLabel ? `${id} · ${binding.workspaceLabel}` : id;
}

// The compact indicator next to the chat controls: one of four states, never an alarm.
function indicatorModel(state) {
  if (!state || !state.current) return { kind: 'unknown', text: 'Vínculo: …', tone: 'neutral', title: 'Sem dados de vínculos ainda.' };
  const c = state.current;
  if (c.state === 'unknown') return { kind: 'unknown', text: 'Identidade pendente', tone: 'neutral', title: UNKNOWN_REASON[c.reason] || 'A identidade desta conversa ainda não é conhecida.' };
  if (c.state === 'unbound') return { kind: 'unbound', text: 'Chat sem vínculo', tone: 'warning', title: 'Esta conversa não está vinculada a nenhum workspace. Clique para vincular.' };
  const b = c.binding;
  const name = workspaceName(state, b);
  const detail = STATUS_TEXT[b.status] ? ` (${STATUS_TEXT[b.status]})` : '';
  if (c.state === 'bound-here') return { kind: 'bound-here', text: `Vinculado: ${name}`, tone: 'success', title: `Conversa "${displayLabel(b)}" vinculada ao workspace selecionado, ${name}.${detail}` };
  return {
    kind: 'bound-elsewhere',
    text: b.status === 'orphan' ? 'Vinculado a workspace ausente' : `Vinculado a ${name}`,
    tone: 'warning',
    title: `Esta conversa pertence a outro workspace: ${name}${detail}. Ela não está vinculada ao workspace selecionado.`
  };
}

// Does writing to `targetId` need the user's explicit confirmation of the destination? Mirrors the service rule
// (main enforces it regardless of what the UI does).
function needsTargetConfirmation(state, targetId) {
  if (!state) return true;
  if (state.workspaces.length === 1) return false;
  return !(state.selected && state.selected.origin === 'dock' && state.selected.workspaceId === targetId);
}

// Model of the panel for the destination `targetId` (defaults to the selected workspace).
function panelModel(state, targetId) {
  if (!state) return { ready: false, message: 'Sem dados ainda.' };
  const id = targetId !== undefined ? targetId : (state.selected ? state.selected.workspaceId : (state.workspaces[0] ? state.workspaces[0].id : null));
  const target = findWs(state, id);
  const connected = state.connection === 'connected';
  const mine = state.bindings.filter((b) => b.workspaceIdentity.session === state.session && b.workspaceIdentity.workspaceId === id);
  const row = (b) => ({
    bindingId: b.bindingId,
    label: displayLabel(b),
    rawLabel: b.label,
    role: b.role,
    roleLabel: roleLabel(b.role),
    status: b.status,
    statusText: STATUS_TEXT[b.status] || '',
    url: b.url,
    origin: b.origin === 'current-page' ? 'vinculada pela página atual' : 'vinculada por URL',
    here: state.current && state.current.conversationKey === b.conversationKey
  });
  const orphans = state.bindings.filter((b) => b.status === 'orphan').map((b) => ({ ...row(b), workspace: workspaceName(state, b) }));
  const selectedNote = state.selected ? (ORIGIN_NOTE[state.selected.origin] || state.selected.origin) : '';
  const canWrite = connected && state.store.writable && !state.pending;
  let blocked = '';
  if (!state.store.writable) blocked = 'Vínculos em modo somente leitura.';
  else if (!connected) blocked = 'Herdr desconectado: não é possível verificar o workspace de destino.';
  else if (state.pending) blocked = 'Troca de workspace em andamento.';
  else if (!target) blocked = state.workspaces.length ? 'Selecione um workspace de destino.' : 'Nenhum workspace na sessão.';
  const current = state.current || { state: 'unknown', reason: 'no-page' };
  return {
    ready: true,
    targetId: target ? target.id : null,
    targetText: target ? wsLabel(target) : '',
    targetNote: target && state.selected && state.selected.workspaceId === target.id ? selectedNote : (target ? 'escolhido neste painel' : ''),
    options: state.workspaces.map((w) => ({ id: w.id, text: wsLabel(w) })),
    rows: mine.map(row),
    empty: mine.length === 0 ? 'Nenhuma conversa vinculada a este workspace.' : '',
    orphans,
    canWrite,
    blocked,
    needsConfirm: Boolean(target) && needsTargetConfirmation(state, target.id),
    roles: state.roles.map((r) => ({ value: r, text: roleLabel(r) })),
    storeNotice: state.store.notice ? state.store.notice.message : '',
    currentSummary: current.state === 'unknown'
      ? (UNKNOWN_REASON[current.reason] || 'Identidade desconhecida.')
      : (current.state === 'unbound' ? 'A conversa atual não está vinculada.' : `A conversa atual está vinculada a ${workspaceName(state, current.binding)}.`),
    canBindCurrent: current.state === 'unbound' || current.state === 'bound-elsewhere'
  };
}

module.exports = { indicatorModel, panelModel, needsTargetConfirmation, roleLabel, wsLabel, ROLE_LABELS, ORIGIN_NOTE, STATUS_TEXT, UNKNOWN_REASON };
