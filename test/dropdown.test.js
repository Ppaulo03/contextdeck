'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createDocument, load } = require('./helpers/fake-dom');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const ITEMS = [{ value: 'w1', text: 'w1 · api' }, { value: 'w2', text: 'w2 · app' }, { value: 'w3', text: 'w3 · app' }];

function mount({ value = 'w1', items = ITEMS } = {}) {
  const document = createDocument([]);
  const { createDropdown } = load(path.join(SRC, 'components', 'dropdown.js'), { document });
  const changes = [];
  const dd = createDropdown({ key: 'target', label: 'Destino', items, value, onChange: (v) => changes.push(v), document });
  const rows = () => dd.popup.children[0].children;
  return {
    document, dd, changes, rows, trigger: dd.trigger,
    key: async (k, extra) => { const e = await dd.trigger.fire('keydown', { key: k, ...extra }); return e; },
    outside: () => document.fire('mousedown', { target: { parent: null } })
  };
}

test('the closed dropdown shows the chosen item and exposes it accessibly; the list is hidden', () => {
  const t = mount({ value: 'w2' });
  assert.equal(t.trigger.tag, 'button');
  assert.equal(t.trigger.textContent, 'w2 · app');
  assert.equal(t.trigger.value, 'w2');
  assert.equal(t.trigger.getAttribute('role'), 'combobox');
  assert.equal(t.trigger.getAttribute('aria-haspopup'), 'listbox');
  assert.equal(t.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(t.trigger.getAttribute('aria-label'), 'Destino');
  assert.equal(t.dd.popup.hidden, true);
  assert.ok(t.trigger.classList.contains('control') && t.trigger.classList.contains('select'), 'the same trigger as the workspace selector and the Git pickers');
});

test('it opens with the SAME list markup as every other dropdown: .menu / .menu-item rows in a .dd-popup', async () => {
  const t = mount({ value: 'w2' });
  await t.trigger.fire('click');
  assert.equal(t.dd.popup.hidden, false);
  assert.ok(t.dd.popup.classList.contains('dd-popup'));
  const list = t.dd.popup.children[0];
  assert.ok(list.classList.contains('menu'));
  assert.equal(list.getAttribute('role'), 'listbox');
  assert.deepEqual(t.rows().map((r) => [r.classList.contains('menu-item'), r.getAttribute('role'), r.getAttribute('aria-selected')]), [[true, 'option', 'false'], [true, 'option', 'true'], [true, 'option', 'false']]);
  assert.deepEqual(t.rows().map((r) => r.textContent), ITEMS.map((i) => i.text));
  assert.ok(t.rows()[1].classList.contains('is-selected') && t.rows()[1].classList.contains('is-active'), 'opens on the chosen item');
  assert.equal(t.trigger.getAttribute('aria-expanded'), 'true');
  assert.equal(t.trigger.getAttribute('aria-activedescendant'), t.rows()[1].id);
});

test('the list floats above its panel (fixed, placed from the trigger) so it never extends the panel scroll area; it closes when the panel scrolls', async () => {
  const t = mount();
  await t.trigger.fire('click');
  assert.equal(t.dd.popup.style.left, '100px');
  assert.equal(t.dd.popup.style.top, '50px', 'right under the trigger (rect: top 20, height 26, gap 4)');
  assert.equal(t.dd.popup.style.bottom, 'auto');
  assert.match(t.dd.popup.children[0].style.maxHeight, /^\d+px$/);
  assert.equal(t.document.listeners.scroll.length, 1);
  await t.document.fire('scroll', { target: { parent: null } });
  assert.equal(t.dd.isOpen(), false, 'a stale placement is not kept');
  assert.equal((t.document.listeners.scroll || []).length, 0);
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  assert.match(/^\.dd-popup \{([^}]*)\}/m.exec(css)[1], /position: fixed/);
  assert.doesNotMatch(/^\.dd-popup \{([^}]*)\}/m.exec(css)[1], /position: absolute|top: calc/);
});

test('with no room below the trigger the list opens upward, and its height is limited to the room', async () => {
  const saved = globalThis.innerHeight;
  globalThis.innerHeight = 90;                         // the trigger (rect bottom 46) leaves ~32 px below and ~8 above: still prefers the larger side
  try {
    const t = mount();
    await t.trigger.fire('click');
    assert.ok(t.dd.popup.style.top === 'auto' || t.dd.popup.style.bottom === 'auto', 'one anchor only');
    assert.ok(parseInt(t.dd.popup.children[0].style.maxHeight, 10) >= 96, 'never smaller than a usable list');
  } finally { globalThis.innerHeight = saved; }
});

test('clicking an item chooses it once, closes the list and gives focus back to the trigger; choosing the current one changes nothing', async () => {
  const t = mount();
  await t.trigger.fire('click');
  await t.rows()[2].fire('click');
  assert.deepEqual(t.changes, ['w3']);
  assert.equal(t.trigger.textContent, 'w3 · app');
  assert.equal(t.trigger.value, 'w3');
  assert.equal(t.dd.popup.hidden, true);
  assert.equal(t.document.activeElement, t.trigger);
  await t.trigger.fire('click');
  await t.rows()[2].fire('click');
  assert.deepEqual(t.changes, ['w3'], 'same value: no change event');
});

test('keyboard: arrows open and move, Home/End jump, Enter and Space choose, Esc closes only the list, Tab closes it', async () => {
  const t = mount();
  const first = await t.key('ArrowDown');
  assert.equal(t.dd.isOpen(), true);
  assert.equal(first.defaultPrevented, true);
  await t.key('ArrowDown'); assert.ok(t.rows()[1].classList.contains('is-active'));
  await t.key('End'); assert.ok(t.rows()[2].classList.contains('is-active'));
  await t.key('ArrowDown'); assert.ok(t.rows()[2].classList.contains('is-active'), 'does not wrap');
  await t.key('Home'); assert.ok(t.rows()[0].classList.contains('is-active'));
  await t.key('ArrowDown'); await t.key('Enter');
  assert.deepEqual(t.changes, ['w2']);
  assert.equal(t.dd.isOpen(), false);
  await t.key(' ');
  assert.equal(t.dd.isOpen(), true);
  await t.key('ArrowDown'); await t.key(' ');
  assert.deepEqual(t.changes, ['w2', 'w3']);
  await t.key('Enter');
  const esc = await t.key('Escape');
  assert.equal(t.dd.isOpen(), false);
  assert.equal(esc.defaultPrevented, true, 'Esc is consumed here, so the panel behind it stays open');
  await t.key('ArrowUp');
  await t.key('Tab');
  assert.equal(t.dd.isOpen(), false);
  assert.deepEqual(t.changes, ['w2', 'w3']);
  const ignored = await t.key('x');
  assert.equal(ignored.defaultPrevented, undefined);
});

test('a click anywhere else closes the list without choosing; hovering moves the highlight; the mouse and the keyboard highlight are distinct', async () => {
  const t = mount();
  await t.trigger.fire('click');
  await t.rows()[2].fire('mousemove');
  assert.ok(t.rows()[2].classList.contains('is-active'));
  assert.equal(t.dd.popup.children[0].classList.contains('is-keyboard'), false);
  await t.key('ArrowUp');
  assert.equal(t.dd.popup.children[0].classList.contains('is-keyboard'), true, 'the visible focus ring only appears for keyboard use');
  await t.outside();
  assert.equal(t.dd.isOpen(), false);
  assert.deepEqual(t.changes, []);
  assert.equal(t.document.listeners.mousedown.length, 0, 'the outside-click listener is removed when closed');
  await t.trigger.fire('click');
  await t.trigger.fire('click');
  assert.equal(t.dd.isOpen(), false, 'the trigger toggles');
});

test('an empty list does not open; text is rendered as text', async () => {
  const empty = mount({ items: [], value: undefined });
  await empty.trigger.fire('click');
  assert.equal(empty.dd.isOpen(), false);
  const hostile = mount({ items: [{ value: 'a', text: '<img src=x onerror=alert(1)>' }], value: 'a' });
  assert.equal(hostile.trigger.textContent, '<img src=x onerror=alert(1)>');
  assert.ok(hostile.rows()[0]._all().every((n) => n.tag !== 'img'));
});

// ---- the panels: closing buttons ------------------------------------------------------------------------------------------

function mountPanels() {
  const document = createDocument(['scrim', 'menu', 'menu-search', 'menu-list', 'menu-message', 'chats', 'chats-body', 'chats-message', 'chats-close', 'activity', 'activity-body', 'activity-message', 'activity-close', 'conflict', 'conflict-title', 'conflict-text', 'conflict-actions', 'conflict-message', 'notices']);
  for (const id of ['scrim', 'chats', 'chats-message', 'activity', 'activity-message', 'notices']) document.getElementById(id).hidden = true;
  let openCb;
  const calls = { close: 0 };
  const g = { global: { totals: { responding: 0, attention: 0, drafts: 0, observed: 0, loaded: 0 }, groups: [], selectedId: null }, notices: { items: [], more: 0 } };
  const chatState = { session: 'contextdeck', store: { status: 'ok', notice: null, writable: true }, connection: 'connected', selected: { workspaceId: 'w1', origin: 'dock' }, pending: false, workspaces: [{ id: 'w1', label: 'api', directory: '' }], roles: ['general'], current: { state: 'unbound', conversationKey: 'c:x', selectedId: 'w1' }, bindings: [] };
  const window = {
    innerWidth: 1200,
    overlay: {
      getState: async () => ({}), choose: async () => ({ ok: true }), close: async () => { calls.close += 1; },
      onConflict: () => () => {}, onOpen: (cb) => { openCb = cb; return () => {}; }, onState: () => () => {}, onChatsState: () => () => {}, onActivityState: () => () => {},
      chatsState: async () => chatState, chatsBind: async () => ({ ok: false }), chatsUpdate: async () => ({ ok: false }), chatsUnbind: async () => ({ ok: false }), chatsReassign: async () => ({ ok: false }),
      activityState: async () => g, activityOpen: async () => ({ ok: false }), activityDismiss: async () => ({ ok: true })
    }
  };
  load(path.join(SRC, 'overlay', 'overlay.js'), { document, window });
  return { document, calls, open: (kind) => openCb({ x: 800, y: 20, width: 100, height: 26, kind }), get: (id) => document.getElementById(id) };
}

test('the × of the activity center and of the bindings panel closes the overlay', async () => {
  for (const [kind, panel, close] of [['activity', 'activity', 'activity-close'], ['chats', 'chats', 'chats-close']]) {
    const t = mountPanels();
    await t.open(kind);
    assert.equal(t.get(panel).hidden, false, kind);
    await t.get(close).fire('click');
    assert.equal(t.calls.close, 1, `${kind}: the overlay was asked to close`);
    assert.equal(t.get(panel).hidden, true, `${kind}: the panel is hidden at once`);
    assert.equal(t.get('scrim').hidden, true);
  }
});

test('Esc inside an open dropdown of the bindings panel closes the list only; a second Esc closes the panel', async () => {
  const t = mountPanels();
  await t.open('chats');
  const trigger = t.get('chats-body')._all().find((n) => n.dataset && n.dataset.key === 'target');
  await trigger.fire('click');
  assert.equal(trigger.getAttribute('aria-expanded'), 'true');
  await trigger.fire('keydown', { key: 'Escape' });
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(t.calls.close, 0, 'the panel is still open');
  await t.document.fire('keydown', { key: 'Escape' });
  assert.equal(t.calls.close, 1);
});

// ---- consistency of every opened list and of the spinner ------------------------------------------------------------------------

test('all lists share one container look and one row look (no per-list overrides of surface, border, radius, shadow or padding)', () => {
  const components = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  const overlay = fs.readFileSync(path.join(SRC, 'overlay', 'overlay.css'), 'utf8');
  const shared = /\.menu-panel, \.picker-panel, \.dd-popup \{([^}]*)\}/.exec(components);
  assert.ok(shared, 'one rule for the three containers');
  for (const prop of ['padding', 'background: var(--bg-raised)', 'border: 1px solid var(--border-strong)', 'border-radius: var(--radius-lg)', 'box-shadow: var(--shadow-popover)']) assert.ok(shared[1].includes(prop), prop);
  assert.doesNotMatch(components.replace(shared[0], ''), /\.picker-panel \{[^}]*(background|border|border-radius|box-shadow)/, 'the Git picker keeps no look of its own');
  const menuPanel = /\.menu-panel \{([^}]*)\}/.exec(overlay)[1];
  assert.doesNotMatch(menuPanel, /background|border|box-shadow/, 'the overlay rule only places the panel');
  assert.equal([...components.matchAll(/^\.menu-item \{/gm)].length, 1, 'one row rule');
  assert.doesNotMatch(overlay, /^\.menu-item \{/m);
});

test('no native <select> is left in the application (the operating system draws its open list differently)', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(SRC).filter((x) => /\.(js|html)$/.test(x))) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8').replace(/^\s*\/\/.*$/gm, ''), /<select|el\('select'|createElement\('select'/, path.relative(SRC, f));
  }
});

test('one spinner for the whole application: the same arc everywhere, one keyframes, off with reduced motion', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  const rule = /\.select\[aria-busy="true"\] \.select-caret::before,\s*\.chat-tab-spin,\s*\.status-ico\.is-responding,\s*\.act-ico\.is-spin,\s*\.act-ico\.is-responding \{([^}]*)\}/.exec(css);
  assert.ok(rule, 'a single rule for every spinner');
  assert.match(rule[1], /conic-gradient/);
  assert.match(rule[1], /mask:/);
  assert.match(rule[1], /animation: spin var\(--duration-spin\) linear infinite/);
  assert.equal([...css.matchAll(/@keyframes/g)].length, 1);
  assert.doesNotMatch(css, /border-top-color/, 'no flat bordered spinner is left');
  assert.match(fs.readFileSync(path.join(SRC, 'styles', 'base.css'), 'utf8'), /prefers-reduced-motion: reduce[\s\S]*animation/);
});
