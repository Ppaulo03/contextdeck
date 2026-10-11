// The dropdown of the local overlay pages (M01-I3B-2H polish): a select-like trigger plus a list that opens with exactly the
// same look as every other list of the application (the workspace menu, the Git pickers): `.dd-popup` and `.menu` /
// `.menu-item` from components.css. It replaces the operating system's <select>, whose open list is drawn by the OS and
// looks different. The list is part of the page (inside the overlay), so it needs no native popup.
//
// Keyboard: Enter / Space / ArrowDown / ArrowUp open it; ArrowUp/Down, Home, End move; Enter or Space choose; Esc closes only
// the list (the key does not reach the panel that contains it); Tab closes it. A click outside closes it. The trigger's
// `value` always holds the chosen value (also what the tests read).
import { el } from './dom.js';

export function createDropdown({ key, label, items, value, onChange, document: doc = document }) {
  const root = el('div', 'dd');
  const trigger = el('button', 'control select dd-trigger');
  trigger.type = 'button';
  trigger.dataset.key = key;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  if (label) trigger.setAttribute('aria-label', label);
  const text = el('span', 'select-text');
  const caret = el('span', 'select-caret');
  caret.setAttribute('aria-hidden', 'true');
  trigger.append(text, caret);
  const popup = el('div', 'dd-popup');
  popup.hidden = true;
  const list = el('ul', 'menu');
  list.setAttribute('role', 'listbox');
  if (label) list.setAttribute('aria-label', label);
  popup.append(list);
  root.append(trigger, popup);

  let current = value;
  let active = -1;
  let open = false;
  let keyboard = false;

  const itemOf = (v) => items.find((i) => i.value === v);
  const rows = () => Array.from(list.children);

  function paint() {
    const selected = itemOf(current);
    text.textContent = selected ? selected.text : '';
    text.classList.toggle('is-placeholder', !selected);
    trigger.value = current === undefined || current === null ? '' : String(current);
    rows().forEach((row, i) => {
      const isSel = items[i].value === current;
      row.classList.toggle('is-selected', isSel);
      row.classList.toggle('is-active', i === active);
      row.setAttribute('aria-selected', String(isSel));
    });
    list.classList.toggle('is-keyboard', keyboard);
    const row = rows()[active];
    if (row) { trigger.setAttribute('aria-activedescendant', row.id); if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' }); } else trigger.removeAttribute('aria-activedescendant');
  }

  items.forEach((item, i) => {
    const row = el('li', 'menu-item');
    row.id = `dd-${key}-${i}`;
    row.setAttribute('role', 'option');
    row.dataset.value = String(item.value);
    row.append(el('span', 'menu-label', item.text));
    row.addEventListener('mousemove', () => { if (active !== i || keyboard) { active = i; keyboard = false; paint(); } });
    row.addEventListener('click', () => choose(i));
    list.append(row);
  });

  const onOutside = (event) => { if (open && !root.contains?.(event.target) && !isInside(event.target)) close(false); };
  // (the fake DOM of the tests has no contains(): walk up the parents instead)
  function isInside(node) { for (let n = node; n; n = n.parent || n.parentNode) if (n === root) return true; return false; }

  function openList() {
    if (open || !items.length) return;
    open = true;
    popup.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    active = Math.max(0, items.findIndex((i) => i.value === current));
    keyboard = false;
    paint();
    doc.addEventListener('mousedown', onOutside);
  }

  function close(refocus) {
    if (!open) return;
    open = false;
    popup.hidden = true;
    active = -1;
    trigger.setAttribute('aria-expanded', 'false');
    doc.removeEventListener('mousedown', onOutside);
    paint();
    if (refocus) trigger.focus();
  }

  function choose(i) {
    const item = items[i];
    if (!item) return;
    const changed = item.value !== current;
    current = item.value;
    close(true);
    paint();
    if (changed) onChange(current);
  }

  function move(delta) {
    if (!items.length) return;
    active = delta === 'first' ? 0 : delta === 'last' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, (active < 0 ? 0 : active) + delta));
    keyboard = true;
    paint();
  }

  trigger.addEventListener('click', () => { if (open) close(true); else openList(); });
  trigger.addEventListener('keydown', (event) => {
    const k = event.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') { event.preventDefault(); event.stopPropagation?.(); openList(); keyboard = true; paint(); }
      return;
    }
    if (k === 'Escape') { event.preventDefault(); event.stopPropagation?.(); close(true); return; }
    if (k === 'Tab') { close(false); return; }
    if (k === 'ArrowDown') move(1);
    else if (k === 'ArrowUp') move(-1);
    else if (k === 'Home') move('first');
    else if (k === 'End') move('last');
    else if (k === 'Enter' || k === ' ') { if (active >= 0) choose(active); }
    else return;
    event.preventDefault();
    event.stopPropagation?.();
  });

  paint();
  return { root, trigger, popup, isOpen: () => open, close: () => close(false) };
}
