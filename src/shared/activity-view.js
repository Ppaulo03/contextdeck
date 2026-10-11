'use strict';

// Pure view-models of the global activity UI (M01-I3B-2H): the top-bar indicator, the activity center and the in-app
// notices. No DOM and no Electron. They render `activity:state` = { global, notices } (see
// src/main/chat-views/navigator.js#getGlobalActivity and src/main/activity/notices.js); they decide nothing.
//
// Words matter here: "Atividade para revisar" is activity that ended while the user was not looking. It is never
// "concluída": the detector cannot tell a finished answer from a stopped or failed one. A conversation that was never
// loaded is simply absent (never "ociosa").

const GLYPH = { responding: '↻', attention: '●', draft: '✎' };
const STATE_TEXT = { responding: 'Respondendo', attention: 'Atividade para revisar', draft: 'Rascunho não enviado' };
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function indicatorModel(payload) {
  const g = payload && payload.global;
  if (!g) return { ready: false, parts: [], text: '', idle: true, title: 'Atividade dos chats: sem dados ainda.', aria: 'Atividade dos chats: sem dados ainda.' };
  const t = g.totals;
  const parts = [];
  if (t.responding > 0) parts.push({ kind: 'responding', glyph: GLYPH.responding, count: t.responding, label: plural(t.responding, 'conversa respondendo', 'conversas respondendo') });
  if (t.attention > 0) parts.push({ kind: 'attention', glyph: GLYPH.attention, count: t.attention, label: plural(t.attention, 'conversa com atividade para revisar', 'conversas com atividade para revisar') });
  if (t.drafts > 0) parts.push({ kind: 'draft', glyph: GLYPH.draft, count: t.drafts, label: plural(t.drafts, 'conversa com rascunho não enviado', 'conversas com rascunho não enviado') });
  const idle = parts.length === 0;
  const observed = t.loaded === 0
    ? 'Nenhuma conversa carregada: conversas que você ainda não abriu não são observadas.'
    : `${plural(t.observed, 'conversa observada', 'conversas observadas')} de ${plural(t.loaded, 'carregada', 'carregadas')}.`;
  const summary = idle ? `Nenhuma atividade observada. ${observed}` : `${parts.map((p) => p.label).join('; ')}. ${observed}`;
  return {
    ready: true,
    parts,
    text: parts.map((p) => `${p.glyph}${p.count}`).join(' '),
    idle,
    attention: t.attention > 0,
    title: `Atividade dos chats: ${summary} Clique para ver todos os workspaces.`,
    aria: `Atividade dos chats: ${idle ? 'nenhuma atividade observada' : parts.map((p) => p.label).join(', ')}`
  };
}

const workspaceTitle = (g) => (g.id === null ? 'Sem workspace' : `${g.label || '(sem nome)'} · ${g.id}`);

// Groups by workspace (name AND id, so homonyms are told apart); each item lists its states with text, not only glyphs.
// "Sem workspace" (M01-I3B-3): conversations that belong to no workspace, ALWAYS listed (idle ones too), because the section is
// the only way back to them. They are never attached to the selected workspace by being listed here.
function unboundModel(g) {
  const list = Array.isArray(g.unbound) ? g.unbound : [];
  const items = list.map((u) => {
    const states = ['responding', 'attention', 'draft'].filter((k) => u[k]).map((kind) => ({ kind, glyph: GLYPH[kind], text: STATE_TEXT[kind] }));
    const status = u.failed ? 'Falha ao carregar' : u.loading ? 'Carregando' : u.identity === 'durable' ? 'Ociosa' : 'Sem identidade persistente ainda';
    const stateText = states.length ? states.map((s) => s.text).join(' · ') : status;
    const label = `${u.label} · ${u.hint}`;
    return {
      viewId: u.viewId,
      label,
      states,
      stateText,
      bindable: u.bindable,
      bindHint: u.bindable ? '' : 'Envie a primeira mensagem para que a conversa ganhe identidade e possa ser vinculada.',
      warning: u.duplicate ? 'Outra aba mostra a mesma conversa.' : '',
      active: Boolean(u.active),
      aria: `Sem workspace, ${label}: ${stateText}`
    };
  });
  return {
    title: `Sem workspace (${items.length})`,
    items,
    empty: items.length ? '' : 'Nenhuma conversa sem workspace.',
    workspaces: (Array.isArray(g.workspaces) ? g.workspaces : []).map((w) => ({ id: w.id, text: `${w.id} · ${w.label || '(sem nome)'}` })),
    selectedId: g.selectedId === undefined ? null : g.selectedId
  };
}

function centerModel(payload, armedViewId = null) {
  const g = payload && payload.global;
  if (!g) return { ready: false, groups: [], empty: 'Sem dados ainda.', unbound: null };
  const groups = g.groups.map((group) => ({
    key: group.key || 'none',
    id: group.id,
    title: workspaceTitle(group),
    current: group.id !== null && group.id === g.selectedId,
    items: group.items.map((item) => {
      const states = ['responding', 'attention', 'draft'].filter((k) => item[k]).map((kind) => ({ kind, glyph: GLYPH[kind], text: STATE_TEXT[kind] }));
      const armed = armedViewId === item.viewId;      // armed by the first click, or because main asked for the confirmation
      return {
        viewId: item.viewId,
        bindingId: item.bindingId,
        workspaceId: group.id,
        label: item.label,
        kind: item.kind,
        states,
        stateText: states.map((s) => s.text).join(' · '),
        openable: item.openable && group.id !== null,
        needsConfirm: item.needsConfirm,
        armed,
        buttonLabel: armed ? 'Confirmar e abrir' : 'Abrir',
        hint: item.needsConfirm ? (item.status === 'suspect' ? 'A identidade deste workspace não foi verificada: confirme para abrir.' : 'Herdr desconectado: confirme para abrir.') : '',
        aria: `${workspaceTitle(group)}, ${item.label}: ${states.map((s) => s.text).join(', ')}`
      };
    })
  }));
  const t = g.totals;
  return {
    ready: true,
    groups,
    unbound: unboundModel(g),
    empty: groups.length ? '' : (t.loaded === 0 ? 'Nenhuma conversa carregada. Conversas que você ainda não abriu não são observadas.' : 'Nenhuma atividade nas conversas observadas.')
  };
}

function noticeModel(notice) {
  const where = notice.workspaceId ? `${notice.workspaceLabel || '(sem nome)'} · ${notice.workspaceId}` : 'Sem workspace';
  return {
    id: notice.id,
    title: 'Atividade para revisar',
    subtitle: `${where} · ${notice.label}`,
    glyph: GLYPH.attention,
    openable: notice.openable && notice.workspaceId !== null,
    target: notice.bindingId ? { workspaceId: notice.workspaceId, bindingId: notice.bindingId } : { workspaceId: notice.workspaceId, viewId: notice.viewId },
    openLabel: 'Abrir conversa'
  };
}

function noticesModel(payload) {
  const n = (payload && payload.notices) || { items: [], more: 0 };
  return { items: n.items.map(noticeModel), more: n.more, moreText: n.more > 0 ? `+${n.more} ${n.more === 1 ? 'aviso' : 'avisos'} (veja a central de atividade)` : '' };
}

module.exports = { indicatorModel, centerModel, noticeModel, noticesModel, workspaceTitle, GLYPH, STATE_TEXT };
