// Diagnostic panel for the Herdr workspace integration (M01-I1). Read-only: it only displays what
// the main process discovered. It lives over the terminal area (not the footer) because the
// ChatGPT view would hide it, so it is only reachable in terminal mode.
import { $, el, setAttr } from './dom.js';

const ACTIVE_TEXT = {
  known: 'Identificado com evidencia confiavel.',
  ambiguous: 'Ambiguo: a API do Herdr nao informa o foco por cliente. O candidato e apenas o ultimo foco da sessao (de qualquer cliente).',
  unknown: 'Nao identificado: sem dados utilizaveis.'
};
const REASON_TEXT = {
  single_workspace_in_session: 'a sessao tem um unico workspace',
  api_has_no_per_client_focus: 'foco da sessao = ultimo cliente que mudou, nao este cliente',
  no_workspaces: 'a sessao nao tem workspaces',
  no_data: 'ainda sem leitura'
};
const CONNECTION_TEXT = { stopped: 'parado', connecting: 'conectando', connected: 'conectado', disconnected: 'desconectado' };

export function initHerdrPanel({ dock, store }) {
  const button = $('herdr-diag');
  const panel = $('herdr-panel');
  const body = $('herdr-panel-body');
  let state = null;

  const time = (ms) => (ms ? new Date(ms).toLocaleTimeString() : '-');
  const row = (label, value, title) => {
    const r = el('div', 'diag-row');
    r.append(el('span', 'diag-label', label), el('span', 'diag-value', value));
    if (title) r.title = title;
    return r;
  };

  function render() {
    body.textContent = '';
    if (!state) { body.append(el('p', 'diag-note', 'Sem dados ainda.')); return; }
    const model = state.model;
    const head = el('div', 'diag-head');
    head.append(el('span', `diag-badge ${state.connection}`, CONNECTION_TEXT[state.connection] || state.connection), el('strong', '', `sessao ${state.session}`));
    body.append(head);
    body.append(row('Servidor', model ? `Herdr ${model.serverVersion || '?'} · protocolo ${model.protocol ?? '?'} (${model.compatibility === 'tested' ? 'testado' : 'nao testado'})` : '-'));
    body.append(row('Ultima sincronizacao', state.lastSync ? `${time(state.lastSync.at)} · ${state.lastSync.reason} · ${state.syncCount} leituras` : '-', 'Estado sempre lido do snapshot autoritativo; eventos so sinalizam mudancas.'));
    body.append(row('Ultimo evento', state.lastEvent ? `${state.lastEvent.type}${state.lastEvent.workspaceId ? ` (${state.lastEvent.workspaceId})` : ''} · ${time(state.lastEvent.at)} · ${state.eventCount} recebidos` : '-'));
    if (state.lastError) body.append(row('Erro', `${state.lastError.code}: ${state.lastError.message}${state.attempts ? ` · tentativas: ${state.attempts}` : ''}`));

    const active = state.active;
    const box = el('div', `diag-active ${active.status}`);
    const who = active.status === 'known' ? active.workspaceId : (active.candidateId ? `candidato ${active.candidateId}` : '-');
    box.append(el('div', '', `Workspace ativo neste cliente: ${active.status.toUpperCase()} · ${who}`));
    box.append(el('div', 'diag-note', `${ACTIVE_TEXT[active.status]} (${REASON_TEXT[active.reason] || active.reason}; evidencia: ${active.evidence})`));
    body.append(box);

    const sel = state.selection;
    if (sel) {
      const origin = { dock: 'escolhido no ContextDeck', herdr: 'acompanhando o foco do Herdr', recovery: 'recuperado' };
      body.append(row('Seletor', `${sel.mode === 'auto' ? 'automatico' : 'manual'} · ${sel.selected ? `${sel.selected.workspaceId} (${origin[sel.selected.origin] || sel.selected.origin})` : (sel.unavailableId ? `${sel.unavailableId} indisponivel` : 'nenhum')}`, 'Automatico segue o ultimo foco da sessao; manual so muda por escolha explicita.'));
      body.append(row('Foco observado', `${sel.observedId || '-'} · confiabilidade: ${{ only_workspace: 'certa (workspace unico)', last_writer: 'estimativa (ultimo cliente que mudou)', none: 'sem dados' }[sel.reliability] || sel.reliability}`));
      if (sel.pending) body.append(row('Troca pendente', `${sel.pending.workspaceId} desde ${time(sel.pending.startedAt)}`));
      if (sel.lastError) body.append(row('Ultimo erro do seletor', `${sel.lastError.code}: ${sel.lastError.message}`));
    }

    const table = el('table', 'diag-table');
    const header = el('tr');
    for (const h of ['', 'ID', 'Nome', 'Diretorio', 'Tabs/Panes']) header.append(el('th', '', h));
    table.append(header);
    for (const w of (model ? model.workspaces : [])) {
      const tr = el('tr');
      const mark = el('td', 'diag-mark', w.sessionFocused ? '●' : '');
      mark.title = w.sessionFocused ? 'Ultimo foco da sessao (qualquer cliente)' : '';
      tr.append(mark, el('td', 'diag-id', w.id), el('td', '', w.label || '(sem nome)'), el('td', 'diag-dir', w.directory || '-'), el('td', '', `${w.tabCount ?? '?'}/${w.paneCount ?? '?'}`));
      tr.querySelector('.diag-dir').title = w.directory || '';
      table.append(tr);
    }
    body.append(table);
    if (model && model.workspaces.length === 0) body.append(el('p', 'diag-note', 'Nenhum workspace na sessao.'));
    body.append(el('p', 'diag-note', '● = ultimo foco da sessao; nao e o workspace visivel neste cliente.'));
  }

  const show = () => { panel.hidden = false; setAttr(button, 'aria-expanded', true); state = store.get(); render(); panel.focus(); };
  const hide = () => { panel.hidden = true; setAttr(button, 'aria-expanded', false); };

  button.addEventListener('click', () => (panel.hidden ? show() : hide()));
  $('herdr-panel-close').addEventListener('click', hide);
  $('herdr-panel-refresh').addEventListener('click', async () => { store.apply(await dock.herdrRefresh()); });
  panel.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.stopPropagation(); hide(); button.focus(); } });
  store.subscribe((next) => { state = next; if (!panel.hidden) render(); });

  return { hide };
}
