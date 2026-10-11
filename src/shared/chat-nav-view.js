'use strict';

// Pure view-model of the conversation strip (M01-I3B-1): what each tab shows, which one is selected, and the
// empty-state text. No DOM and no Electron. The state it reads is `chatnav:state` (see
// src/main/chat-views/navigator.js#getState). The strip never decides anything: it renders, and main re-validates
// every click.

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

// Indicators of a conversation (M01-I3B-2). Each has a distinct SHAPE (not only a color) and a text. "Attention" means
// activity that ended while the user could not see it: it does not claim the response succeeded.
const STATUS = {
  responding: { glyph: 'ring', label: 'Respondendo', title: 'Esta conversa está respondendo.' },
  attention: { glyph: '\u25CF', label: 'Atividade para revisar', title: 'Houve atividade nesta conversa enquanto você não a via. Isso não indica que terminou com sucesso: abra para revisar.' },
  draft: { glyph: '\u270E', label: 'Rascunho não enviado', title: 'Há texto digitado e não enviado nesta conversa (o conteúdo não é lido).' },
  unknown: { glyph: '?', label: 'Estado desconhecido', title: 'Não foi possível observar o estado desta conversa (a página pode ter mudado). Ela continua utilizável.' }
};

function statusItems(activity) {
  if (!activity) return [];
  const out = [];
  if (activity.responding) out.push('responding');
  if (activity.attention) out.push('attention');
  if (activity.draft) out.push('draft');
  if (activity.unknown && !activity.responding) out.push('unknown');
  return out.map((kind) => ({ kind, ...STATUS[kind] }));
}

const workspaceName = (w) => (w ? (w.label || w.id) : null);

// What the user must decide about the page on screen: a conversation that belongs to another workspace (go / transfer / back),
// or one that could not be bound yet (retry). Words only; nothing is decided here.
const wsText = (w) => (w.label ? `${w.label} (${w.id})` : w.id);
function bannerOf(state, armedTransfer) {
  const c = state.conflict;
  if (c) {
    const actions = [];
    if (c.boundTo.openable) actions.push({ action: 'go', label: `Ir para ${c.boundTo.label || c.boundTo.id}`, title: 'Troca de workspace e abre esta conversa la' });
    if (c.transferable) actions.push({ action: 'transfer', label: armedTransfer ? 'Confirmar transferência' : 'Transferir vínculo…', armed: Boolean(armedTransfer), title: 'Move o vínculo desta conversa para o workspace atual' });
    actions.push({ action: 'back', label: 'Voltar', title: 'Volta ao que você via neste workspace; a conversa fica no workspace dela' });
    return { kind: 'conflict', viewId: c.viewId, text: `Esta conversa pertence ao workspace ${wsText(c.boundTo)}. Você está em ${wsText(c.current)}.`, actions };
  }
  const p = state.pending;
  if (p) {
    const text = typeof p === 'string' ? p : p.text;
    if (p.kind === 'offer') return { kind: 'offer', viewId: state.activeViewId, text, actions: [{ action: 'link-project', label: 'Vincular Project', title: 'Vincula este Project ao workspace: novas conversas dele começam aqui' }, { action: 'skip', label: 'Agora não', title: 'Não perguntar de novo para este Project nesta sessão' }] };
    if (p.kind === 'confirm') return { kind: 'confirm', viewId: state.activeViewId, text, actions: [{ action: 'retry', label: 'Vincular', title: 'Vincula esta conversa ao workspace, mesmo fora do Project dele' }, { action: 'back', label: 'Voltar', title: 'Volta ao que você via; a conversa não é vinculada' }] };
    return { kind: 'pending', viewId: state.activeViewId, text, actions: [{ action: 'retry', label: 'Tentar vincular', title: 'Tenta associar esta conversa ao workspace' }, { action: 'skip', label: 'Agora não', title: 'Fechar este aviso; a conversa continua no workspace' }] };
  }
  return null;
}

function barModel(state, armedBindingId = null, armedTransfer = false) {
  if (!state) return { ready: false, banner: null, title: 'ChatGPT', workspaceTitle: '', workspaceKey: null, tabs: [], temporaries: [], empty: null, canCreate: false, createLabel: 'Nova conversa', duplicates: 0 };
  const ws = state.workspace;
  const tabs = state.tabs.map((t) => {
    const armed = armedBindingId === t.bindingId && t.needsConfirm;
    const notes = [];
    if (STATUS_NOTE[t.status]) notes.push(STATUS_NOTE[t.status]);
    if (t.failed) notes.push('Falha ao carregar: clique para tentar de novo.');
    const off = t.relation && t.relation !== 'match' && t.relation !== 'loading';
    if (off && RELATION_NOTE[t.relation]) notes.push(RELATION_NOTE[t.relation]);
    const status = statusItems(t.activity);
    if (status.length) notes.push(status.map((s) => s.title).join(' '));
    return {
      id: t.bindingId,
      status,
      aria: status.map((s) => s.label).join(', '),
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
    id: t.viewId, status: statusItems(t.activity), aria: statusItems(t.activity).map((s) => s.label).join(', '), text: t.label, active: t.active, loading: t.loading, failed: t.failed, warn: t.warning || Boolean(t.note),
    title: [t.failed ? 'Falha ao carregar.' : (RELATION_NOTE[t.relation] || RELATION_NOTE.temporary), t.note || '', ...statusItems(t.activity).map((s) => s.title)].filter(Boolean).join(' ')
  }));
  return {
    ready: true,
    title: ws ? `ChatGPT · ${workspaceName(ws)}` : 'ChatGPT · sem workspace',
    workspaceTitle: ws ? `Workspace ${ws.id}${ws.pending ? ' (troca em andamento)' : ''}` : 'Nenhum workspace selecionado',
    banner: bannerOf(state, armedTransfer),
    workspaceKey: ws ? ws.key : null,
    tabs,
    temporaries,
    empty: state.empty ? { reason: state.empty, ...EMPTY[state.empty] } : null,
    canCreate: Boolean(ws) && !ws.pending,
    createLabel: ws ? 'Nova conversa' : 'Abrir ChatGPT',
    duplicates: state.duplicates
  };
}

module.exports = { bannerOf, barModel, statusItems, STATUS, STATUS_NOTE, RELATION_NOTE, EMPTY };
