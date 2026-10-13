// Chat bindings panel (M01-I3A): the second mode of the overlay view. It lists the conversations bound to a
// workspace, binds the current conversation or one typed by URL, edits label/category, unbinds, resolves
// conflicts by explicit reassignment and shows orphans. Everything it knows comes from main (`chats:state`);
// every write is re-validated there. The panel never selects a workspace and never touches Herdr: the
// destination is a choice made inside this panel (`targetId`), checked against the workspace that was
// selected when the panel opened (`selectedAtOpen`) so a change in between forces a review.
import { $, el } from '../components/dom.js';
import { panelModel } from '../../shared/chat-bindings-view.js';
import { lifeModel } from '../../shared/lifecycle-view.js';
import { createDropdown } from '../components/dropdown.js';

// Depth-first lookup by data-key (the panel is rebuilt on every render; this restores the focused control).
function findByKey(root, key) {
  for (const child of Array.from(root.children)) {
    if (child.dataset && child.dataset.key === key) return child;
    const inner = findByKey(child, key);
    if (inner) return inner;
  }
  return null;
}

export function createChatsPanel({ api, closeOverlay }) {
  const panel = $('chats');
  const body = $('chats-body');
  const message = $('chats-message');
  let state = null;
  let targetId = null;
  let selectedAtOpen = null;
  const chosen = true;           // the destination (the current workspace by default, or the one picked here) is on screen when the button is pressed
  let editing = null;
  let unbinding = null;
  let conflict = null;
  let projectIssue = null;       // a refused Project link waiting for an explicit decision
  let projectUrl = '';
  let projectLabel = '';         // the name the user gives the Project (the page's name is never read)
  let unlinking = false;
  let busy = false;
  let draft = { label: '', url: '' };
  let anchor = null;

  const selectedId = () => (state && state.selected ? state.selected.workspaceId : null);
  const isStale = () => Boolean(state) && selectedId() !== selectedAtOpen;
  const target = () => ({ session: state.session, workspaceId: targetId });
  // An estimated selection is not proposed as the destination: the user chooses one (no checkbox, no second click).
  // The destination is the workspace we are in, always: pressing the button with it on screen is the choice.
  const defaultTarget = () => selectedId();

  function say(text, isError = false) {
    message.textContent = text || '';
    message.hidden = !text;
    message.classList.toggle('is-error', Boolean(isError));
  }

  function position() {
    if (!anchor) return;
    const width = panel.offsetWidth || 440;
    const left = Math.max(8, Math.min(anchor.x + anchor.width - width, window.innerWidth - width - 8));
    panel.style.left = `${left}px`;
    panel.style.top = `${Math.round(anchor.y + anchor.height + 4)}px`;
  }

  function section(title) {
    const s = el('div', 'chats-section');
    if (title) s.append(el('h3', 'chats-title', title));
    return s;
  }

  function button(text, onClick, { disabled = false, title = '', danger = false, key = '' } = {}) {
    const b = el('button', `btn${danger ? ' btn-danger' : ''}`, text);
    b.type = 'button';
    b.disabled = disabled || busy;
    if (title) b.title = title;
    if (key) b.dataset.key = key;
    b.addEventListener('click', onClick);
    return b;
  }

  function input(key, value, placeholder, maxLength, onInput) {
    const i = el('input', 'control');
    i.type = 'text';
    i.value = value;
    i.placeholder = placeholder;
    i.maxLength = maxLength;
    i.spellcheck = false;
    i.dataset.key = key;
    i.addEventListener('input', () => onInput(i.value));
    return i;
  }

  // ---- actions ---------------------------------------------------------------------------------------------------
  async function run(task) {
    if (busy) return null;
    busy = true;
    say('Aguarde…');
    render();
    let result;
    try { result = await task(); } catch (error) { result = { ok: false, error: { message: (error && error.message) || 'Falha inesperada.' } }; }
    busy = false;
    say('');
    try { state = (await api.chatsState()) || state; } catch { /* The push will catch up. */ }
    return result;
  }

  // `targetChosen` only says the destination was picked here; main still verifies it against Herdr.
  const common = () => ({ target: target(), selectedAtOpen, targetChosen: chosen });

  async function bind(source, m) {
    const args = { source, ...common(m), label: draft.label };
    if (source === 'url') args.url = draft.url;
    const result = await run(() => api.chatsBind(args));
    if (!result) return;
    if (result.ok) { draft = { ...draft, label: '', url: '' }; conflict = null; say('Conversa vinculada.'); }
    else if (result.error && result.error.code === 'conflict') { conflict = { binding: result.error.binding }; say(''); }
    else say(result.error && result.error.message ? result.error.message : 'Não foi possível vincular.', true);
    render();
  }

  async function reassign(bindingId, m) {
    const result = await run(() => api.chatsReassign({ bindingId, ...common(m), confirmReassign: true }));
    if (!result) return;
    if (result.ok) { conflict = null; say('Conversa reassociada.'); }
    else say(result.error && result.error.message ? result.error.message : 'Não foi possível reassociar.', true);
    render();
  }

  // ---- Project of the workspace (experimental: only when main says projectsEnabled) ------------------------------------------
  async function linkProject(source, extra = {}) {
    const args = { source, ...common(), ...extra };
    if (projectLabel.trim()) args.label = projectLabel.trim();
    if (source === 'url') args.url = projectUrl;
    const result = await run(() => api.projectsLink(args));
    if (!result) return;
    if (result.ok) { projectIssue = null; projectUrl = ''; projectLabel = ''; say(result.renamed ? 'Project atualizado (nome alterado no ChatGPT).' : 'Project vinculado.'); }
    else if (result.error && ['project_already_linked', 'project_conflict', 'workspace_suspect'].includes(result.error.code)) { projectIssue = { code: result.error.code, message: result.error.message, source }; say(''); }
    else say(result.error && result.error.message ? result.error.message : 'Não foi possível vincular o Project.', true);
    render();
  }

  // Renaming is re-linking the SAME Project with another label (same id: the record is updated, nothing else changes).
  async function renameProject(record) {
    const result = await run(() => api.projectsLink({ source: 'url', url: record.url, label: projectLabel.trim(), target: target(), selectedAtOpen, targetChosen: true }));
    if (!result) return;
    if (result.ok) { projectLabel = ''; say('Nome atualizado.'); } else say((result.error && result.error.message) || 'Não foi possível salvar o nome.', true);
    render();
  }

  async function unlinkProject() {
    unlinking = false;
    const result = await run(() => api.projectsUnlink({ target: target() }));
    if (!result) return;
    say(result.ok ? 'Vínculo do Project removido. Nada mais foi alterado.' : (result.error && result.error.message) || 'Não foi possível remover.', !result.ok);
    render();
  }

  function projectSection(m, writable) {
    const p = state.projects;
    const sec = section('Project ChatGPT (experimental)');
    const record = p ? p.records.find((r) => r.workspaceIdentity.session === state.session && r.workspaceIdentity.workspaceId === m.targetId) : null;
    if (p && p.store && p.store.notice) sec.append(el('p', 'chats-note is-warning', p.store.notice.message));
    if (record) {
      const status = record.status === 'linked' ? '' : (record.status === 'suspect' ? ' · identidade do workspace não verificada' : ' · ' + record.status);
      sec.append(el('p', 'chats-note', 'Project: ' + (record.label || '(sem nome)') + status + '. Novas conversas deste workspace começam nele; as existentes não foram movidas.'));
      const row = el('div', 'chats-row');
      if (unlinking) row.append(button('Confirmar', () => void unlinkProject(), { danger: true, title: 'Remove só o vínculo; o Project no ChatGPT não é alterado' }), button('Não', () => { unlinking = false; render(); }));
      else row.append(button('Remover vínculo', () => { unlinking = true; render(); }, { danger: true, key: 'project-unlink' }));
      sec.append(row);
    } else sec.append(el('p', 'chats-note', 'Nenhum Project vinculado a este workspace.'));
    sec.append(el('div', 'chats-row', ''));
    sec.children[sec.children.length - 1].append(input('project-label', projectLabel, record ? 'Novo nome do Project (opcional)' : 'Nome do Project (opcional)', 80, (v) => { projectLabel = v; }));
    if (record) sec.children[sec.children.length - 1].append(button('Salvar nome', () => void renameProject(record), { disabled: !writable || !projectLabel.trim(), key: 'project-rename', title: 'Só muda o nome mostrado aqui' }));
    const cur = p && p.current;
    sec.append(el('p', 'chats-note', cur ? 'Página atual: Project "' + (cur.label || cur.projectId) + '"' + (cur.linkedTo ? ' (já vinculado a ' + cur.linkedTo.workspaceId + ')' : '') + '.' : 'Abra um Project no ChatGPT e volte aqui para vinculá-lo.'));
    const row = el('div', 'chats-row');
    row.append(button(record ? 'Trocar pelo Project atual' : 'Vincular Project atual', () => void linkProject('current'), { disabled: !writable || !cur, key: 'project-link-current' }));
    sec.append(row);
    const byUrl = el('div', 'chats-row');
    byUrl.append(input('project-url', projectUrl, 'https://chatgpt.com/g/g-p-…/project', 2048, (v) => { projectUrl = v; }), button('Vincular por URL', () => void linkProject('url'), { disabled: !writable || !projectUrl.trim(), key: 'project-link-url' }));
    sec.append(byUrl);
    if (projectIssue) {
      const box = el('div', 'chats-banner');
      box.append(el('span', '', projectIssue.message + ' '));
      const flag = projectIssue.code === 'project_conflict' ? { move: true } : { replace: true };
      const text = projectIssue.code === 'project_conflict' ? 'Mover para este workspace' : 'Substituir';
      box.append(button(text, () => { const src = projectIssue.source; projectIssue = null; void linkProject(src, flag); }, { key: 'project-decide', disabled: !writable }), button('Cancelar', () => { projectIssue = null; render(); }));
      sec.append(box);
    }
    return sec;
  }

  async function saveEdit(bindingId, values) {
    const result = await run(() => api.chatsUpdate({ bindingId, label: values.label }));
    if (!result) return;
    if (result.ok) { editing = null; say('Vínculo atualizado.'); }
    else say(result.error && result.error.message ? result.error.message : 'Não foi possível salvar.', true);
    render();
  }

  // Release the page of a conversation (M01-I3C-1). The button exists only for a page main reported as suspendable; main judges again.
  async function suspend(bindingId) {
    const result = await run(() => api.chatsSuspend({ bindingId }));
    if (!result) return;
    if (result.ok) say('Conversa suspensa. Ela continua na lista e é recarregada quando você a abrir.');
    else if (result.error && result.error.reasons && result.error.reasons.length) say(`Não foi suspensa: ${lifeModel({ state: 'background', eligible: false, reasons: result.error.reasons }).reasons.join(' ')}`, true);
    else say((result.error && result.error.message) || 'Não foi possível suspender.', true);
    render();
  }

  async function unbind(bindingId) {
    unbinding = null;
    const result = await run(() => api.chatsUnbind({ bindingId }));
    if (!result) return;
    say(result.ok ? 'Vínculo removido. A conversa no ChatGPT não foi alterada.' : (result.error && result.error.message) || 'Não foi possível desvincular.', !result.ok);
    render();
  }

  // ---- rendering -------------------------------------------------------------------------------------------------
  function itemRow(row, m, { orphan = false } = {}) {
    const item = el('div', `chats-item${row.here ? ' is-here' : ''}${row.statusText ? ' is-problem' : ''}`);
    item.dataset.id = row.bindingId;
    if (editing === row.bindingId) {
      const values = { label: row.rawLabel };
      item.append(input(`edit-label-${row.bindingId}`, values.label, 'Rótulo', 80, (v) => { values.label = v; }));
      item.append(button('Salvar', () => void saveEdit(row.bindingId, values)), button('Cancelar', () => { editing = null; render(); }));
      return item;
    }
    const main = el('div', 'chats-item-main');
    main.append(el('span', 'chats-item-label', `${row.label}${row.here ? ' (esta página)' : ''}`));
    const detail = [orphan ? `era de ${row.workspace}` : '', row.statusText, row.origin].filter(Boolean).join(' · ');
    const detailNode = el('span', 'chats-item-detail', detail);
    detailNode.title = `${detail}
${row.url}`;   // the row is ellipsised; the tooltip has the rest
    main.append(detailNode);
    // What the page costs and why it can (not) be released: only for a conversation that has a page (or was suspended).
    if (row.life && !orphan) {
      const life = el('span', 'chats-item-life', row.life.canSuspend || row.life.state === 'suspended' ? row.life.stateText : `${row.life.stateText} · ${row.life.reasons.join(' ')}`);
      life.title = row.life.help;
      main.append(life);
    }
    item.append(main);
    if (row.life && (row.life.canSuspend || row.life.canVerifyUnsent) && !orphan) item.append(button(row.life.label, () => void suspend(row.bindingId), { disabled: busy, title: row.life.help, key: `suspend-${row.bindingId}` }));
    if (orphan) item.append(button('Reassociar aqui', () => void reassign(row.bindingId, m), { disabled: !m.canWrite || isStale() || !m.targetId || false, title: 'Move este vínculo para o destino escolhido acima' }));
    else item.append(button('Editar', () => { editing = row.bindingId; render(); }));
    if (unbinding === row.bindingId) {
      item.append(button('Confirmar', () => void unbind(row.bindingId), { danger: true, title: 'Remove só o vínculo; a conversa no ChatGPT não é excluída' }), button('Não', () => { unbinding = null; render(); }));
    } else {
      item.append(button('Desvincular', () => { unbinding = row.bindingId; render(); }, { danger: true }));
    }
    return item;
  }

  function render() {
    const active = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : '';
    const m = panelModel(state, targetId);
    body.textContent = '';
    if (!m.ready) { body.append(el('p', 'chats-note', m.message)); return; }
    const stale = isStale();
    const writable = m.canWrite && !stale && Boolean(m.targetId) && !busy;

    const dest = section('Destino');
    if (stale) {
      const banner = el('div', 'chats-banner');
      banner.append(el('span', '', 'O workspace selecionado mudou desde que este painel foi aberto. Nada foi gravado; revise o destino. '), button('Usar o selecionado agora', () => { selectedAtOpen = selectedId(); targetId = defaultTarget(); conflict = null; render(); }, { key: 'review' }));
      dest.append(banner);
    }
    const pick = createDropdown({
      key: 'target',
      label: 'Workspace de destino',
      items: m.options.map((o) => ({ value: o.id, text: o.text })),
      value: m.targetId || undefined,
      onChange: (value) => { targetId = value; conflict = null; render(); }
    });
    const pickRow = el('div', 'chats-row');
    pickRow.append(pick.root);
    dest.append(pickRow);
    if (m.targetNote) dest.append(el('p', 'chats-note', `Destino ${m.targetText} (${m.targetNote}).`));
    if (m.blocked) dest.append(el('p', 'chats-note is-warning', m.blocked));
    if (m.storeNotice) dest.append(el('p', 'chats-note is-warning', m.storeNotice));
    body.append(dest);

    const listSection = section('Conversas deste workspace');
    for (const row of m.rows) listSection.append(itemRow(row, m));
    if (m.empty) listSection.append(el('p', 'chats-note', m.empty));
    body.append(listSection);

    const bindSection = section('Vincular');
    bindSection.append(el('p', 'chats-note', m.currentSummary));
    const meta = el('div', 'chats-row');
    meta.append(input('label', draft.label, 'Rótulo (opcional)', 80, (v) => { draft.label = v; }));
    bindSection.append(meta);
    const current = el('div', 'chats-row');
    current.append(button('Vincular conversa atual', () => void bind('current', m), { disabled: !writable || !m.canBindCurrent, key: 'bind-current', title: m.canBindCurrent ? '' : 'A página atual não tem uma conversa com identidade persistente' }));
    bindSection.append(current);
    const byUrl = el('div', 'chats-row');
    byUrl.append(input('url', draft.url, 'https://chatgpt.com/c/…', 2048, (v) => { draft.url = v; }), button('Vincular por URL', () => void bind('url', m), { disabled: !writable || !draft.url.trim(), key: 'bind-url' }));
    bindSection.append(byUrl);
    body.append(bindSection);
    if (state.projectsEnabled) body.append(projectSection(m, writable));

    if (conflict && conflict.binding) {
      const box = section('Conflito');
      const where = conflict.binding.workspaceLabel ? `${conflict.binding.workspaceIdentity.workspaceId} · ${conflict.binding.workspaceLabel}` : conflict.binding.workspaceIdentity.workspaceId;
      box.append(el('div', 'chats-banner', `Esta conversa já está vinculada a ${where} como "${conflict.binding.label || '(sem rótulo)'}". Uma conversa pertence a um único workspace; nada foi alterado.`));
      const actions = el('div', 'chats-row');
      actions.append(button(`Reassociar para ${m.targetText}`, () => void reassign(conflict.binding.bindingId, m), { disabled: !writable, key: 'reassign' }), button('Cancelar', () => { conflict = null; render(); }));
      box.append(actions);
      body.append(box);
    }

    if (m.orphans.length) {
      const orphans = section('Vínculos órfãos');
      orphans.append(el('p', 'chats-note', 'O workspace destes vínculos não existe mais no Herdr. Eles foram preservados; reassocie ao destino acima ou desvincule.'));
      for (const row of m.orphans) orphans.append(itemRow(row, m, { orphan: true }));
      body.append(orphans);
    }

    if (active) { const again = findByKey(body, active); if (again) again.focus(); }
    position();
  }

  $('chats-close').addEventListener('click', () => void closeOverlay());

  return {
    async open(opened) {
      anchor = opened;
      busy = false; editing = null; unbinding = null; conflict = null; projectIssue = null; projectUrl = ''; projectLabel = ''; unlinking = false;
      draft = { label: '', url: '' };
      say('');
      state = await api.chatsState();
      selectedAtOpen = selectedId();
      targetId = defaultTarget();
      panel.hidden = false;
      render();
      position();
      const first = findByKey(body, 'target');
      if (first) first.focus();
    },
    hide() { panel.hidden = true; },
    push(next) { if (!panel.hidden && next) { state = next; render(); } },
    // Returns true when the key was handled here.
    handleKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); void closeOverlay(); return true; }
      return false;
    }
  };
}
