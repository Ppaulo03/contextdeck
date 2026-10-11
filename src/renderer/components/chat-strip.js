// Conversation strip under the top bar (ChatGPT tab only, M01-I3B-1): the conversations bound to the selected
// workspace, the temporary ones opened under it, "+" for a new conversation and "Gerenciar" for the I3A panel.
// It renders `chatnav:state` and reports the user's clicks; main decides (and re-validates) everything. A click on
// a conversation whose workspace is not verified needs a second click (the first one arms it).
import { $, el, setAttr, setText } from './dom.js';
import { barModel } from '../../shared/chat-nav-view.js';

export function initChatStrip({ dock, feedback, openChatsPanel }) {
  const title = $('chatbar-ws');
  const tabsRoot = $('chatbar-tabs');
  const newButton = $('chatbar-new');
  const manageButton = $('chatbar-manage');
  const empty = $('chat-empty');
  const emptyTitle = $('chat-empty-title');
  const emptyText = $('chat-empty-text');
  const emptyNew = $('chat-empty-new');
  const emptyManage = $('chat-empty-manage');
  let state = null;
  let armed = null;
  let armedTransfer = false;
  let model = barModel(null);

  const tabButtons = () => Array.from(tabsRoot.children).filter((n) => n.dataset && n.dataset.key);

  function tab(item, onClick, index, activeIndex) {
    const b = el('button', `chat-tab${item.active ? ' is-active' : ''}${item.warn ? ' is-warn' : ''}${item.armed ? ' is-armed' : ''}`);
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(item.active));
    b.tabIndex = index === activeIndex ? 0 : -1;
    b.title = item.title;
    b.dataset.key = item.id;
    if (item.loading) {
      const spin = el('span', 'chat-tab-spin');
      spin.setAttribute('aria-hidden', 'true');
      b.setAttribute('aria-busy', 'true');
      b.append(spin);
    }
    b.append(el('span', 'chat-tab-text', item.text));
    // A fixed-size slot, always present: indicators come and go without changing the width of the tab.
    const slot = el('span', 'chat-tab-status');
    slot.setAttribute('aria-hidden', 'true');
    for (const s of item.status) slot.append(el('span', `status-ico is-${s.kind}`, s.glyph === 'ring' ? '' : s.glyph));
    b.append(slot);
    if (item.aria) b.setAttribute('aria-label', `${item.text}, ${item.aria}`);
    b.addEventListener('click', onClick);
    return b;
  }

  function render(next) {
    state = next || state;
    model = barModel(state, armed, armedTransfer);
    if (!model.banner || model.banner.kind !== 'conflict') armedTransfer = false;
    const focusedKey = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.key : '';
    setText(title, model.title);
    if (title.title !== model.workspaceTitle) title.title = model.workspaceTitle;
    const all = [...model.tabs.map((t) => ({ ...t, kind: 'binding' })), ...model.temporaries.map((t) => ({ ...t, kind: 'temporary' }))];
    const activeIndex = Math.max(0, all.findIndex((t) => t.active));
    tabsRoot.textContent = '';
    all.forEach((item, index) => tabsRoot.append(tab(item, () => void choose(item), index, activeIndex)));
    if (!all.length && model.ready && model.workspaceKey && !model.banner) tabsRoot.append(el('span', 'chatbar-none', 'Sem conversas vinculadas'));
    // A conflict is a modal (overlay), not a strip item; only a pending association is offered here.
    if (model.banner && model.banner.kind === 'pending') tabsRoot.append(bannerNode(model.banner));
    newButton.disabled = !model.ready || (Boolean(model.workspaceKey) && !model.canCreate);
    setAttr(newButton, 'aria-label', model.createLabel);
    newButton.title = model.workspaceKey ? 'Nova conversa temporária neste workspace (não é vinculada automaticamente)' : 'Abrir o ChatGPT sem vínculo';
    if (focusedKey) {
      const again = tabButtons().find((b) => b.dataset.key === focusedKey);
      if (again) again.focus();
    }
    renderEmpty();
  }

  // A decision about the page on screen (conflict with another workspace, or an association that is still pending).
  function bannerNode(banner) {
    const box = el('span', 'chatbar-banner');
    box.setAttribute('role', 'alert');
    box.append(el('span', 'chatbar-banner-text', banner.text));
    for (const a of banner.actions) {
      const b = el('button', 'btn' + (a.armed ? ' is-armed' : ''), a.label);
      b.type = 'button';
      b.title = a.title;
      b.dataset.bannerAction = a.action;
      b.addEventListener('click', () => void resolveBanner(banner, a));
      box.append(b);
    }
    return box;
  }

  async function resolveBanner(banner, a) {
    if (a.action === 'transfer' && !armedTransfer) { armedTransfer = true; render(); return; }   // the first click arms it
    armedTransfer = false;
    await call(() => dock.chatNavResolve({ viewId: banner.viewId, action: a.action }));
    render();
  }

  function renderEmpty() {
    const e = model.empty;
    empty.hidden = !e;
    if (!e) return;
    setText(emptyTitle, e.title);
    setText(emptyText, e.text);
    setText(emptyNew, model.createLabel);
    emptyNew.disabled = Boolean(model.workspaceKey) && !model.canCreate;
    emptyManage.hidden = !model.workspaceKey;
  }

  async function call(task) {
    let result;
    try { result = await task(); } catch (error) { result = { ok: false, error: { message: (error && error.message) || 'Falha inesperada.' } }; }
    if (result && result.ok === false && result.error && result.error.code !== 'confirmation_required') feedback.error(result.error.message || 'Não foi possível concluir a ação.');
    return result;
  }

  async function choose(item) {
    if (!model.workspaceKey) return;
    if (item.kind === 'temporary') {
      armed = null;
      await call(() => dock.chatNavSelectTemporary({ viewId: item.id, workspaceKey: model.workspaceKey }));
      return;
    }
    if (item.needsConfirm && armed !== item.id) { armed = item.id; render(); return; }   // the first click arms, the second confirms
    const confirm = Boolean(item.needsConfirm);
    armed = null;
    await call(() => dock.chatNavSelect({ bindingId: item.id, workspaceKey: model.workspaceKey, confirm }));
    render();
  }

  async function createNew() {
    armed = null;
    if (!model.workspaceKey) { await call(() => dock.chatNavOpenUnscoped()); return; }
    await call(() => dock.chatNavNew({ workspaceKey: model.workspaceKey }));
  }

  // Roving tabindex: arrows/Home/End move between the conversations; Enter/Space activate the focused button.
  tabsRoot.addEventListener('keydown', (event) => {
    const buttons = tabButtons();
    const index = buttons.indexOf(document.activeElement);
    if (index < 0) return;
    const target = event.key === 'ArrowRight' ? Math.min(buttons.length - 1, index + 1)
      : event.key === 'ArrowLeft' ? Math.max(0, index - 1)
        : event.key === 'Home' ? 0
          : event.key === 'End' ? buttons.length - 1 : -1;
    if (target < 0) return;
    event.preventDefault();
    buttons.forEach((b, i) => { b.tabIndex = i === target ? 0 : -1; });
    buttons[target].focus();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && (armed || armedTransfer)) { armed = null; armedTransfer = false; render(); } });

  newButton.addEventListener('click', () => void createNew());
  emptyNew.addEventListener('click', () => void createNew());
  manageButton.addEventListener('click', () => openChatsPanel(manageButton));
  emptyManage.addEventListener('click', () => openChatsPanel(emptyManage));

  const offState = dock.onChatNavState(render);
  void dock.chatNavState().then((initial) => { if (!state && initial) render(initial); });
  render(null);

  return { dispose() { offState(); } };
}
