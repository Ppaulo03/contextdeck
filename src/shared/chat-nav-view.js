'use strict';

// Pure view-model of the conversation strip (M01-I3B-1): what each tab shows, which one is selected, and the
// empty-state text. No DOM and no Electron. The state it reads is `chatnav:state` (see
// src/main/chat-views/navigator.js#getState). The strip never decides anything: it renders, and main re-validates
// every click.

const ROLE_LABELS = { general: 'Geral', architecture: 'Arquitetura', review: 'Revisão', planning: 'Planejamento' };

const STATUS_NOTE = {
  suspect: 'A identidade deste workspace não foi verificada. Clique duas vezes para confirmar e abrir.',
  unverified: 'Herdr desconectado: o workspace não pôde ser verificado. Clique duas vezes para confirmar e abrir.'
};

const RELATION_NOTE = {
  diverged: 'Esta página mostra outra conversa (navegação dentro do ChatGPT). O vínculo não foi alterado.',
  left: 'Esta página saiu da conversa (por exemplo, "nova conversa" no ChatGPT). O vínculo não foi alterado.',
  acquired: 'Conversa ainda sem vínculo. Use "Gerenciar" para vinculá-la a este workspace.',
  temporary: 'Conversa temporária deste workspace: não está vinculada a nenhuma conversa existente.'
};

const EMPTY = {
  'no-workspace': { title: 'Nenhum workspace selecionado', text: 'Selecione um workspace do Herdr para ver as conversas dele. Você pode abrir o ChatGPT sem vínculo enquanto isso.' },
  'no-conversations': { title: 'Este workspace ainda não tem conversas', text: 'Comece uma nova conversa ou vincule uma existente. Nada é vinculado automaticamente.' },
  'select-conversation': { title: 'Escolha uma conversa', text: 'As conversas deste workspace estão na barra acima.' },
  'not-verified': { title: 'Workspace não verificado', text: 'O Herdr não confirmou a identidade deste workspace. Escolha uma conversa na barra e confirme para abri-la.' }
};

const workspaceName = (w) => (w ? (w.label || w.id) : null);

function barModel(state, armedBindingId = null) {
  if (!state) return { ready: false, title: 'ChatGPT', workspaceTitle: '', workspaceKey: null, tabs: [], temporaries: [], empty: null, canCreate: false, createLabel: 'Nova conversa', duplicates: 0 };
  const ws = state.workspace;
  const tabs = state.tabs.map((t) => {
    const armed = armedBindingId === t.bindingId && t.needsConfirm;
    const notes = [ROLE_LABELS[t.role] || ROLE_LABELS.general];
    if (STATUS_NOTE[t.status]) notes.push(STATUS_NOTE[t.status]);
    if (t.failed) notes.push('Falha ao carregar: clique para tentar de novo.');
    const off = t.relation && t.relation !== 'match' && t.relation !== 'loading';
    if (off && RELATION_NOTE[t.relation]) notes.push(RELATION_NOTE[t.relation]);
    return {
      id: t.bindingId,
      text: armed ? `Confirmar "${t.label}"?` : (t.hint ? `${t.label} · ${t.hint}` : t.label),
      active: t.active,
      loading: t.loading,
      failed: t.failed,
      warn: t.needsConfirm || t.failed || Boolean(off),
      armed,
      needsConfirm: t.needsConfirm,
      title: notes.join(' · ')
    };
  });
  const temporaries = state.temporaries.map((t) => ({
    id: t.viewId, text: t.label, active: t.active, loading: t.loading, failed: t.failed, warn: t.warning,
    title: t.failed ? 'Falha ao carregar.' : (RELATION_NOTE[t.relation] || RELATION_NOTE.temporary)
  }));
  return {
    ready: true,
    title: ws ? `ChatGPT · ${workspaceName(ws)}` : 'ChatGPT · sem workspace',
    workspaceTitle: ws ? `Workspace ${ws.id}${ws.pending ? ' (troca em andamento)' : ''}` : 'Nenhum workspace selecionado',
    workspaceKey: ws ? ws.key : null,
    tabs,
    temporaries,
    empty: state.empty ? { reason: state.empty, ...EMPTY[state.empty] } : null,
    canCreate: Boolean(ws) && !ws.pending,
    createLabel: ws ? 'Nova conversa' : 'Abrir ChatGPT',
    duplicates: state.duplicates
  };
}

module.exports = { barModel, ROLE_LABELS, STATUS_NOTE, RELATION_NOTE, EMPTY };
