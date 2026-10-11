// Activity center and in-app notices (M01-I3B-2H): two modes of the overlay view.
//  - center (modal, `kind: 'activity'`): the activity of EVERY workspace, grouped by workspace (name and id), each item with
//    its states in words and an "Abrir" button. Opening is the user's explicit action; main validates the target, switches
//    workspace through the existing explicit selection, shows the chat tab and selects the conversation (the visit).
//    Nothing is loaded to fill this list and nothing here acknowledges attention.
//  - notices (`kind: 'notice'`): up to three small cards in a small, non-focusing area. Closing a card, or letting it expire,
//    never clears the pending attention.
// All data comes from main (`activity:state`); text is always set with textContent.
import { $, el } from '../components/dom.js';
import { centerModel, noticesModel } from '../../shared/activity-view.js';
import { createDropdown } from '../components/dropdown.js';

export function createActivityOverlay({ api, closeOverlay }) {
  const panel = $('activity');
  const body = $('activity-body');
  const message = $('activity-message');
  const noticeBox = $('notices');
  let state = null;
  let mode = 'hidden';          // 'center' | 'notice' | 'hidden'
  let anchor = null;
  let armed = null;
  let busy = false;
  let binding = null;           // { viewId, workspaceId, label } while the "Vincular" form of an unbound conversation is open

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

  // Depth-first collection of the item buttons (the list is rebuilt on every render).
  const collect = (root, out = []) => { for (const child of Array.from(root.children)) { if (child.tag === 'button' || child.tagName === 'BUTTON') { if (child.dataset && child.dataset.key) out.push(child); } else collect(child, out); } return out; };
  const buttons = () => collect(body);

  async function openTarget(item) {
    if (busy || !item.openable) return;
    if (item.needsConfirm && armed !== item.viewId) { armed = item.viewId; renderCenter(); return; }   // first click arms it
    const confirm = Boolean(item.needsConfirm) || armed === item.viewId;
    armed = null;
    busy = true;
    say('Abrindo…');
    renderCenter();
    let result;
    try {
      result = await api.activityOpen({ workspaceId: item.workspaceId, ...(item.bindingId ? { bindingId: item.bindingId } : { viewId: item.viewId }), confirm });
    } catch (error) { result = { ok: false, error: { message: (error && error.message) || 'Falha inesperada.' } }; }
    busy = false;
    if (result && result.ok) { say(''); void closeOverlay(); return; }
    if (result && result.superseded) { say(''); renderCenter(); return; }
    if (result && result.error && result.error.code === 'confirmation_required') { armed = item.viewId; say(result.error.message); renderCenter(); return; }
    say((result && result.error && result.error.message) || 'Não foi possível abrir a conversa.', true);
    renderCenter();
  }

  // ---- conversations without a workspace -----------------------------------------------------------------------------------
  async function runUnbound(task, done) {
    if (busy) return;
    busy = true;
    say('Aguarde…');
    renderCenter();
    let result;
    try { result = await task(); } catch (error) { result = { ok: false, error: { message: (error && error.message) || 'Falha inesperada.' } }; }
    busy = false;
    if (result && result.ok) { say(''); done(); return; }
    say((result && result.error && result.error.message) || 'Não foi possível concluir a ação.', true);
    renderCenter();
  }

  const openUnbound = (item) => runUnbound(() => api.activityOpenUnbound({ viewId: item.viewId }), () => { void closeOverlay(); });
  const createUnbound = () => runUnbound(() => api.activityNewUnbound(), () => { void closeOverlay(); });
  const bindUnbound = (item, model) => runUnbound(
    () => api.activityBindUnbound({ viewId: item.viewId, workspaceId: binding.workspaceId, label: binding.label, selectedAtOpen: model.selectedId }),
    () => { binding = null; say('Conversa vinculada.'); renderCenter(); }
  );

  function unboundSection(model) {
    const u = model.unbound;
    const section = el('section', 'act-group act-unbound');
    const head = el('h3', 'act-group-title');
    head.append(el('span', 'act-group-name', u.title));
    section.append(head);
    if (u.empty) section.append(el('p', 'act-empty', u.empty));
    for (const item of u.items) {
      const row = el('div', 'act-item');
      const states = el('span', 'act-item-states');
      for (const s of item.states) states.append(el('span', `act-ico is-${s.kind}${s.kind === 'responding' ? ' is-spin' : ''}`, s.kind === 'responding' ? '' : s.glyph));
      states.setAttribute('aria-hidden', 'true');
      const text = el('span', 'act-item-main');
      text.append(el('span', 'act-item-label', item.label), el('span', 'act-item-state', item.stateText));
      if (item.warning) text.append(el('span', 'act-item-hint', item.warning));
      const open = el('button', 'btn', 'Abrir');
      open.type = 'button';
      open.disabled = busy;
      open.dataset.key = `unbound:${item.viewId}`;
      open.setAttribute('aria-label', `Abrir: ${item.aria}`);
      open.addEventListener('click', () => void openUnbound(item));
      const bind = el('button', 'btn', 'Vincular');
      bind.type = 'button';
      bind.disabled = busy || !item.bindable;
      bind.title = item.bindable ? 'Vincular esta conversa a um workspace' : item.bindHint;
      bind.dataset.key = `unbound-bind:${item.viewId}`;
      bind.setAttribute('aria-label', `Vincular a workspace: ${item.aria}`);
      bind.addEventListener('click', () => { binding = binding && binding.viewId === item.viewId ? null : { viewId: item.viewId, workspaceId: u.selectedId || (u.workspaces[0] ? u.workspaces[0].id : null), label: '' }; renderCenter(); });
      row.append(states, text, open, bind);
      section.append(row);
      if (binding && binding.viewId === item.viewId) section.append(bindForm(item, model));
    }
    const create = el('button', 'btn', 'Nova conversa sem workspace');
    create.type = 'button';
    create.disabled = busy;
    create.dataset.key = 'unbound-new';
    create.title = 'Abre uma conversa que não pertence a nenhum workspace';
    create.addEventListener('click', () => void createUnbound());
    section.append(create);
    return section;
  }

  // The destination is chosen here, by name and id; nothing is bound to "the selected workspace" implicitly.
  function bindForm(item, model) {
    const form = el('div', 'act-bind');
    const pick = createDropdown({
      key: `unbound-target:${item.viewId}`,
      label: 'Workspace de destino',
      items: model.unbound.workspaces.map((w) => ({ value: w.id, text: w.text })),
      value: binding.workspaceId || undefined,
      onChange: (value) => { binding.workspaceId = value; renderCenter(); }
    });
    const label = el('input', 'control');
    label.type = 'text';
    label.value = binding.label;
    label.placeholder = 'Rótulo (opcional)';
    label.maxLength = 80;
    label.spellcheck = false;
    label.dataset.key = `unbound-label:${item.viewId}`;
    label.addEventListener('input', () => { binding.label = label.value; });
    const ok = el('button', 'btn', 'Vincular a este workspace');
    ok.type = 'button';
    ok.disabled = busy || !binding.workspaceId;
    ok.dataset.key = `unbound-confirm:${item.viewId}`;
    ok.addEventListener('click', () => void bindUnbound(item, model.unbound));
    const cancel = el('button', 'btn', 'Cancelar');
    cancel.type = 'button';
    cancel.dataset.key = `unbound-cancel:${item.viewId}`;
    cancel.addEventListener('click', () => { binding = null; renderCenter(); });
    form.append(pick.root, label, ok, cancel);
    return form;
  }

  function renderCenter() {
    const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : '';
    const model = centerModel(state, armed);
    body.textContent = '';
    if (!model.ready) { body.append(el('p', 'act-empty', model.empty || 'Sem dados ainda.')); position(); return; }
    if (!model.groups.length) body.append(el('p', 'act-empty', model.empty));
    for (const group of model.groups) {
      const section = el('section', 'act-group');
      const head = el('h3', 'act-group-title');
      head.append(el('span', 'act-group-name', group.title));
      if (group.current) head.append(el('span', 'badge is-success', 'atual'));
      section.append(head);
      for (const item of group.items) {
        const row = el('div', 'act-item');
        const states = el('span', 'act-item-states');
        for (const s of item.states) states.append(el('span', `act-ico is-${s.kind}${s.kind === 'responding' ? ' is-spin' : ''}`, s.kind === 'responding' ? '' : s.glyph));
        states.setAttribute('aria-hidden', 'true');
        const text = el('span', 'act-item-main');
        text.append(el('span', 'act-item-label', item.label), el('span', 'act-item-state', item.stateText));
        if (item.hint) text.append(el('span', 'act-item-hint', item.hint));
        const open = el('button', `btn${item.armed ? ' is-armed' : ''}`, item.buttonLabel);
        open.type = 'button';
        open.disabled = !item.openable || busy;
        open.dataset.key = `${item.workspaceId}:${item.viewId}`;
        open.setAttribute('aria-label', `${item.buttonLabel}: ${item.aria}`);
        open.addEventListener('click', () => void openTarget(item));
        row.append(states, text, open);
        section.append(row);
      }
      body.append(section);
    }
    if (model.unbound) body.append(unboundSection(model));
    if (focusedKey) { const again = buttons().find((b) => b.dataset.key === focusedKey); if (again) again.focus(); }
    position();
  }

  function renderNotices() {
    const model = noticesModel(state);
    noticeBox.textContent = '';
    for (const n of model.items) {
      const card = el('div', 'act-notice');
      card.setAttribute('role', 'status');
      card.dataset.id = n.id;
      const main = el('div', 'act-notice-main');
      main.append(el('span', 'act-notice-title', `${n.glyph} ${n.title}`), el('span', 'act-notice-sub', n.subtitle));
      const actions = el('div', 'act-notice-actions');
      const open = el('button', 'btn', n.openLabel);
      open.type = 'button';
      open.disabled = !n.openable;
      open.addEventListener('click', async () => {
        let result;
        try { result = await api.activityOpen(n.target); } catch { result = null; }
        if (!result || !result.ok) { say(''); main.append(el('span', 'act-notice-error', (result && result.error && result.error.message) || 'Não foi possível abrir a conversa.')); }
      });
      const close = el('button', 'btn btn-icon', '×');
      close.type = 'button';
      close.setAttribute('aria-label', 'Dispensar aviso (a atividade continua pendente)');
      close.title = 'Dispensar aviso: a atividade continua pendente na central';
      close.addEventListener('click', () => void api.activityDismiss({ id: n.id }));
      actions.append(open, close);
      card.append(main, actions);
      noticeBox.append(card);
    }
    if (model.moreText) noticeBox.append(el('p', 'act-notice-more', model.moreText));
  }

  $('activity-close').addEventListener('click', () => void closeOverlay());

  return {
    async openCenter(opened) {
      mode = 'center';
      anchor = opened;
      armed = null; busy = false; binding = null;
      noticeBox.hidden = true;
      say('');
      state = await api.activityState();
      panel.hidden = false;
      renderCenter();
      position();
      const first = buttons().find((b) => !b.disabled);
      if (first) first.focus(); else panel.focus();
    },
    async openNotices() {
      mode = 'notice';
      panel.hidden = true;
      state = await api.activityState();
      noticeBox.hidden = false;
      renderNotices();
    },
    hide() { mode = 'hidden'; panel.hidden = true; noticeBox.hidden = true; noticeBox.textContent = ''; },
    push(next) {
      if (!next) return;
      state = next;
      if (mode === 'center' && !panel.hidden) renderCenter();
      else if (mode === 'notice') renderNotices();
    },
    // Up/Down/Home/End move between the "Abrir" buttons; Esc closes. Returns true when the key was handled.
    handleKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); void closeOverlay(); return true; }
      const list = buttons().filter((b) => !b.disabled);
      const index = list.indexOf(document.activeElement);
      const target = event.key === 'ArrowDown' ? Math.min(list.length - 1, index + 1)
        : event.key === 'ArrowUp' ? Math.max(0, index < 0 ? 0 : index - 1)
          : event.key === 'Home' ? 0
            : event.key === 'End' ? list.length - 1 : -1;
      if (target < 0 || !list.length) return false;
      event.preventDefault();
      list[target].focus();
      return true;
    },
    mode: () => mode
  };
}
