// Workspace menu overlay. Lives in its own local view above the ChatGPT view, so it is visible in
// both tabs. Keyboard: Up/Down/Home/End move, Enter chooses, Esc or Tab close; typing filters when the
// list is long enough to need a search box. All data comes from the main process; choosing a
// workspace goes through the same validated channel as every other selection.
import { $, el, setAttr } from '../components/dom.js';
import { menuModel } from '../../shared/workspace-view.js';
import { createChatsPanel } from './chats-panel.js';
import { createActivityOverlay } from './activity-center.js';

const SEARCH_THRESHOLD = 7;
const scrim = $('scrim');
const panel = $('menu');
const search = $('menu-search');
const list = $('menu-list');
const message = $('menu-message');

let state = null;
let anchor = null;
let query = '';
let activeId = null;
let keyboard = false;
let busy = false;
let mode = 'workspaces';   // which page the overlay shows: 'workspaces' (menu) | 'chats' (bindings) | 'activity' (center) | 'notice' (cards)

const model = () => menuModel(state, query);
const total = () => (state && state.selection ? state.selection.options.length : 0);

function say(text, isError = false) {
  message.textContent = text || '';
  message.hidden = !text;
  message.classList.toggle('is-error', Boolean(isError));
}

function ensureActive(items) {
  if (items.some((i) => i.id === activeId)) return;
  const selected = items.find((i) => i.selected);
  activeId = (selected || items[0] || {}).id || null;
}

function position() {
  const gap = 4;
  const width = panel.offsetWidth || 260;
  const left = Math.max(8, Math.min(anchor.x, window.innerWidth - width - 8));
  panel.style.left = `${left}px`;
  panel.style.top = `${Math.round(anchor.y + anchor.height + gap)}px`;
}

function render() {
  const m = model();
  const showSearch = total() >= SEARCH_THRESHOLD;
  search.hidden = !showSearch;
  ensureActive(m.items);
  list.textContent = '';
  for (const item of m.items) {
    const row = el('li', `menu-item${item.id === activeId ? ' is-active' : ''}${item.selected ? ' is-selected' : ''}`);
    row.id = `opt-${item.id}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(item.selected));
    if (!m.connected) row.setAttribute('aria-disabled', 'true');
    const main = el('div', 'menu-main');
    main.append(el('span', 'menu-label', item.label));
    if (item.detail) main.append(el('span', 'menu-detail', item.detail));
    row.append(main);
    if (item.selected) row.append(el('span', 'badge is-success', 'atual'));
    else if (item.observed) row.append(el('span', 'badge', 'foco Herdr'));
    for (const b of item.badges) {
      const badge = el('span', `badge is-activity is-${b.kind}`, `${b.glyph}${b.count}`);
      badge.title = b.label;
      badge.setAttribute('aria-label', b.label);
      row.append(badge);
    }
    row.addEventListener('mousemove', () => { if (activeId !== item.id || keyboard) { activeId = item.id; keyboard = false; setActive(); } });
    row.addEventListener('click', () => void choose(item.id));
    list.append(row);
  }
  if (!m.items.length) list.append(el('li', 'menu-empty', m.emptyText));
  setActive();
  if (m.unavailableId && !busy) say(`${m.unavailableId} não existe mais. Escolha outro workspace.`, false);
  else if (!busy && !message.classList.contains('is-error')) say('');
}

function setActive() {
  list.classList.toggle('is-keyboard', keyboard);
  const target = search.hidden ? list : search;
  setAttr(target, 'aria-activedescendant', activeId ? `opt-${activeId}` : '');
  for (const row of list.children) row.classList.toggle('is-active', row.id === `opt-${activeId}`);
  const active = activeId && document.getElementById(`opt-${activeId}`);
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function focusMenu() { (search.hidden ? list : search).focus(); }

// Hides the page immediately (so a stale menu can never flash on the next opening) and asks main to remove the view.
function closeMenu() {
  scrim.hidden = true;
  chats.hide();
  activity.hide();
  return window.overlay.close();
}

const chats = createChatsPanel({ api: window.overlay, closeOverlay: closeMenu });
const activity = createActivityOverlay({ api: window.overlay, closeOverlay: closeMenu });

async function choose(id) {
  const m = model();
  if (busy || !m.connected || !state) return;
  busy = true;
  say('Trocando de workspace…');
  let result;
  try { result = await window.overlay.choose({ session: state.session, workspaceId: id }); } catch (error) { result = { ok: false, error: { message: error && error.message } }; }
  busy = false;
  if (result && (result.ok || result.stale)) return void closeMenu();
  say(`Falha: ${(result && result.error && result.error.message) || 'não foi possível trocar de workspace'}`, true);
}

function move(delta) {
  const items = model().items;
  if (!items.length) return;
  const index = items.findIndex((i) => i.id === activeId);
  const next = delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + delta));
  activeId = items[next].id;
  keyboard = true;
  setActive();
}

document.addEventListener('keydown', (event) => {
  if (scrim.hidden) return;
  if (mode === 'chats') { chats.handleKey(event); return; }
  if (mode === 'activity') { activity.handleKey(event); return; }
  switch (event.key) {
    case 'Escape': event.preventDefault(); void closeMenu(); break;
    case 'Tab': event.preventDefault(); void closeMenu(); break;
    case 'ArrowDown': event.preventDefault(); move(1); break;
    case 'ArrowUp': event.preventDefault(); move(-1); break;
    case 'Home': event.preventDefault(); move('first'); break;
    case 'End': event.preventDefault(); move('last'); break;
    case 'Enter': event.preventDefault(); if (activeId) void choose(activeId); break;
    default:
  }
});
search.addEventListener('input', () => { query = search.value; activeId = null; render(); });
scrim.addEventListener('mousedown', (event) => { if (event.target === scrim) void closeMenu(); });

window.overlay.onState((next) => { if (!scrim.hidden && mode === 'workspaces') { state = next; render(); } });
window.overlay.onChatsState((next) => { if (mode === 'chats') chats.push(next); });
window.overlay.onActivityState((next) => { if (mode === 'activity' || mode === 'notice') activity.push(next); });
window.overlay.onOpen(async (opened) => {
  if (!opened) { scrim.hidden = true; chats.hide(); activity.hide(); return; }   // closed from the main process (resize, tab switch...)
  mode = opened.kind === 'chats' ? 'chats' : (opened.kind === 'activity' ? 'activity' : (opened.kind === 'notice' ? 'notice' : 'workspaces'));
  if (mode === 'notice') {
    // Small, non-focusing card area: nothing else is shown and no scrim captures input.
    scrim.hidden = true; chats.hide();
    await activity.openNotices();
    return;
  }
  activity.hide();
  panel.hidden = mode !== 'workspaces';
  if (mode === 'activity') {
    scrim.hidden = false; chats.hide();
    await activity.openCenter(opened);
    return;
  }
  if (mode === 'chats') {
    scrim.hidden = false;
    await chats.open(opened);
    return;
  }
  chats.hide();
  anchor = opened;
  query = '';
  search.value = '';
  activeId = null;
  keyboard = false;
  busy = false;
  say('');
  state = await window.overlay.getState();
  scrim.hidden = false;
  render();
  position();
  focusMenu();
});
