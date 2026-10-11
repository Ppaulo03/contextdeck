'use strict';

// The real renderer components (bundled with esbuild) against a minimal fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createDocument, load } = require('./helpers/fake-dom');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const opts = [{ id: 'w1', label: 'api', directory: 'C:\\a' }, { id: 'w2', label: 'app', directory: 'C:\\b' }, { id: 'w3', label: 'app', directory: 'C:\\c' }];
const state = (sel = {}) => ({
  session: 'contextdeck',
  selection: { mode: 'auto', connection: 'connected', canSelect: true, pending: null, unavailableId: null, observedId: 'w2', lastError: null, options: opts, selected: { workspaceId: 'w2', origin: 'herdr' }, ...sel }
});

// ---- store ------------------------------------------------------------------------------------------------

test('herdr store: one IPC subscription and one initial read shared by every component', async () => {
  const document = createDocument([]);
  const { createHerdrStore } = load(path.join(SRC, 'components', 'herdr-store.js'), { document });
  let pushHandler; let offs = 0; let reads = 0;
  const dock = { onHerdrState: (cb) => { pushHandler = cb; return () => { offs += 1; }; }, herdrState: async () => { reads += 1; return state(); } };
  const store = createHerdrStore(dock);
  const a = []; const b = [];
  store.subscribe((s) => a.push(s)); store.subscribe((s) => b.push(s));
  await new Promise((r) => setImmediate(r));
  assert.equal(reads, 1, 'a single initial read');
  assert.equal(a.length, 1); assert.equal(b.length, 1);
  pushHandler(state({ mode: 'manual' }));
  assert.equal(a.length, 2); assert.equal(a[1].selection.mode, 'manual');
  assert.equal(store.get().selection.mode, 'manual');
  // The late initial read never overwrites a newer push.
  const document2 = createDocument([]);
  const mod2 = load(path.join(SRC, 'components', 'herdr-store.js'), { document: document2 });
  let resolve; let push2;
  const slow = mod2.createHerdrStore({ onHerdrState: (cb) => { push2 = cb; return () => {}; }, herdrState: () => new Promise((r) => { resolve = r; }) });
  push2(state({ mode: 'manual' })); resolve(state({ mode: 'auto' })); await new Promise((r) => setImmediate(r));
  assert.equal(slow.get().selection.mode, 'manual');
  store.dispose(); assert.equal(offs, 1);
  pushHandler(state()); assert.equal(a.length, 2, 'no notifications after dispose');
});

// ---- selector trigger -------------------------------------------------------------------------------------

function mountSelector(initial = state()) {
  const document = createDocument(['ws-trigger', 'ws-trigger-text', 'ws-mode']);
  const { initWorkspaceSelector } = load(path.join(SRC, 'components', 'workspace-selector.js'), { document });
  const subs = new Set(); let current = initial;
  const store = { get: () => current, subscribe: (fn) => { subs.add(fn); if (current) fn(current); return () => subs.delete(fn); } };
  const calls = { open: [], mode: [], errors: [] };
  let closedCb; let openResult = { ok: true };
  const dock = {
    openWorkspaceMenu: async (anchor) => { calls.open.push(anchor); return openResult; },
    herdrSetSyncMode: async (a) => { calls.mode.push(a); return { ok: true }; },
    onOverlayClosed: (cb) => { closedCb = cb; return () => { closedCb = null; }; }
  };
  const handle = initWorkspaceSelector({ dock, store, feedback: { error: (m) => calls.errors.push(m), notice() {} } });
  const el = { trigger: document.getElementById('ws-trigger'), label: document.getElementById('ws-trigger-text'), mode: document.getElementById('ws-mode') };
  return { document, el, calls, handle, subs, push: (s) => { current = s; subs.forEach((f) => f(s)); }, closed: () => closedCb && closedCb(), setOpenResult: (r) => { openResult = r; } };
}

test('trigger renders the selected workspace with accessible state', () => {
  const t = mountSelector();
  assert.equal(t.el.label.textContent, 'w2 · app');
  assert.equal(t.el.trigger.getAttribute('aria-disabled'), 'false');
  assert.equal(t.el.trigger.getAttribute('aria-busy'), 'false');
  assert.equal(t.el.mode.textContent, 'Auto');
  assert.equal(t.el.mode.getAttribute('aria-pressed'), 'true');
  assert.match(t.el.mode.title, /estimativa/);
  assert.doesNotMatch(t.el.trigger.title + t.el.mode.title + t.el.label.textContent, /AMBIGU/i);
});

test('pending operation: label is stable, busy and aria-disabled set, opening is refused; then it settles on the new label', async () => {
  const t = mountSelector();
  const texts = [t.el.label.textContent];
  t.push(state({ pending: { workspaceId: 'w3', startedAt: 1 }, selected: { workspaceId: 'w3', origin: 'dock' }, canSelect: false }));
  texts.push(t.el.label.textContent);
  assert.equal(t.el.trigger.getAttribute('aria-busy'), 'true');
  assert.equal(t.el.trigger.getAttribute('aria-disabled'), 'true');
  await t.el.trigger.fire('click');
  assert.deepEqual(t.calls.open, [], 'no second menu while a switch is pending');
  t.push(state({ selected: { workspaceId: 'w3', origin: 'dock' }, observedId: 'w3' }));
  texts.push(t.el.label.textContent);
  assert.deepEqual(texts, ['w2 · app', 'w2 · app', 'w3 · app'], 'no intermediate "..." text');
  assert.equal(t.el.trigger.getAttribute('aria-busy'), 'false');
});

test('click and arrow keys open the menu with the trigger rectangle; failure is reported; focus returns when it closes', async () => {
  const t = mountSelector();
  await t.el.trigger.fire('click');
  assert.deepEqual(t.calls.open, [{ x: 100, y: 20, width: 200, height: 26 }]);
  assert.equal(t.el.trigger.getAttribute('aria-expanded'), 'true');
  t.closed();
  assert.equal(t.el.trigger.getAttribute('aria-expanded'), 'false');
  assert.equal(t.document.activeElement, t.el.trigger, 'focus returned to the trigger');
  const down = await t.el.trigger.fire('keydown', { key: 'ArrowDown' });
  await t.el.trigger.fire('keydown', { key: 'ArrowUp' });
  const other = await t.el.trigger.fire('keydown', { key: 'a' });
  assert.equal(down.defaultPrevented, true);
  assert.equal(other.defaultPrevented, undefined);
  assert.equal(t.calls.open.length, 3);
  t.setOpenResult({ ok: false });
  await t.el.trigger.fire('click');
  assert.match(t.calls.errors[0], /Não foi possível abrir o menu/);
});

test('disconnected: the trigger keeps the last label (dimmed) and cannot open; reconnect re-enables it', async () => {
  const t = mountSelector();
  t.push(state({ connection: 'disconnected', canSelect: false }));
  assert.equal(t.el.label.textContent, 'w2 · app');
  assert.ok(t.el.label.classList.contains('is-dim'));
  assert.equal(t.el.trigger.getAttribute('aria-disabled'), 'true');
  await t.el.trigger.fire('click');
  assert.equal(t.calls.open.length, 0);
  t.push(state());
  assert.equal(t.el.trigger.getAttribute('aria-disabled'), 'false');
  assert.ok(!t.el.label.classList.contains('is-dim'));
});

test('mode toggle asks for the opposite mode; the component never sends a workspace selection itself', async () => {
  const t = mountSelector();
  await t.el.mode.fire('click');
  assert.deepEqual(t.calls.mode, [{ mode: 'manual' }]);
  t.push(state({ mode: 'manual' }));
  assert.equal(t.el.mode.textContent, 'Manual');
  assert.equal(t.el.mode.getAttribute('aria-pressed'), 'false');
  await t.el.mode.fire('click');
  assert.deepEqual(t.calls.mode, [{ mode: 'manual' }, { mode: 'auto' }]);
});

test('dispose removes the store subscription and the overlay listener (no duplicated listeners after remount)', () => {
  const t = mountSelector();
  assert.equal(t.subs.size, 1);
  t.handle.dispose();
  assert.equal(t.subs.size, 0);
  assert.equal(t.closed(), null);
});

// ---- menu overlay ------------------------------------------------------------------------------------------

function mountOverlay(initial = state(), { innerWidth = 1000 } = {}) {
  const document = createDocument(['scrim', 'menu', 'menu-search', 'menu-list', 'menu-message', 'chats', 'chats-body', 'chats-message']);
  document.getElementById('scrim').hidden = true;
  document.getElementById('chats').hidden = true;
  document.getElementById('chats-message').hidden = true;
  const calls = { choose: [], close: 0 };
  let openCb; let stateCb; let chooseResult = { ok: true };
  const window = {
    innerWidth,
    overlay: {
      getState: async () => initial,
      choose: async (a) => { calls.choose.push(a); return typeof chooseResult === 'function' ? chooseResult() : chooseResult; },
      close: async () => { calls.close += 1; },
      onOpen: (cb) => { openCb = cb; return () => {}; },
      onState: (cb) => { stateCb = cb; return () => {}; },
      onChatsState: () => () => {},
      chatsState: async () => null, chatsBind: async () => ({ ok: false }), chatsUpdate: async () => ({ ok: false }), chatsUnbind: async () => ({ ok: false }), chatsReassign: async () => ({ ok: false })
    }
  };
  load(path.join(SRC, 'overlay', 'overlay.js'), { document, window });
  const el = { scrim: document.getElementById('scrim'), panel: document.getElementById('menu'), search: document.getElementById('menu-search'), list: document.getElementById('menu-list'), message: document.getElementById('menu-message') };
  const rows = () => el.list.children;
  const activeId = () => (rows().find((r) => r.classList.contains('is-active')) || {}).id || null;
  const open = async (anchor = { x: 100, y: 20, width: 200, height: 26 }) => { await openCb(anchor); };
  return { document, el, calls, rows, activeId, open, openCb: (v) => openCb(v), pushState: (s) => stateCb(s), setChooseResult: (r) => { chooseResult = r; }, key: (k, extra) => document.fire('keydown', { key: k, ...extra }) };
}

test('overlay: opens anchored below the trigger, lists id · name with the current one active, list is focused', async () => {
  const o = mountOverlay();
  await o.open();
  assert.equal(o.el.scrim.hidden, false);
  assert.deepEqual(o.rows().map((r) => r.children[0].children[0].textContent), ['w1 · api', 'w2 · app', 'w3 · app']);
  assert.equal(o.rows()[1].getAttribute('aria-selected'), 'true');
  assert.equal(o.activeId(), 'opt-w2');
  assert.equal(o.el.list.getAttribute('aria-activedescendant'), 'opt-w2');
  assert.equal(o.document.activeElement, o.el.list, 'short list: no search box, the listbox takes focus');
  assert.equal(o.el.search.hidden, true);
  assert.deepEqual([o.el.panel.style.left, o.el.panel.style.top], ['100px', '50px']);
  assert.ok(o.rows()[1].children.some((c) => c.textContent === 'atual'));
});

test('overlay: the panel is clamped inside the window', async () => {
  const o = mountOverlay(state(), { innerWidth: 500 });
  await o.open({ x: 480, y: 20, width: 200, height: 26 });
  assert.equal(o.el.panel.style.left, '232px');             // 500 - 260 - 8
  await o.open({ x: -50, y: 20, width: 10, height: 26 });
  assert.equal(o.el.panel.style.left, '8px');
});

test('overlay keyboard: arrows, Home/End, Enter chooses with the session, Esc and Tab close, nothing leaks when hidden', async () => {
  const o = mountOverlay();
  await o.key('ArrowDown');                                   // hidden: ignored
  assert.equal(o.calls.close, 0);
  await o.open();
  await o.key('ArrowDown'); assert.equal(o.activeId(), 'opt-w3');
  await o.key('ArrowDown'); assert.equal(o.activeId(), 'opt-w3', 'does not wrap past the end');
  await o.key('Home'); assert.equal(o.activeId(), 'opt-w1');
  await o.key('ArrowUp'); assert.equal(o.activeId(), 'opt-w1');
  await o.key('End'); assert.equal(o.activeId(), 'opt-w3');
  assert.ok(o.el.list.classList.contains('is-keyboard'), 'visible focus ring only for keyboard use');
  await o.key('Enter');
  assert.deepEqual(o.calls.choose, [{ session: 'contextdeck', workspaceId: 'w3' }]);
  assert.equal(o.calls.close, 1);
  assert.equal(o.el.scrim.hidden, true, 'the page hides immediately when it closes');
  await o.open(); await o.key('Escape');
  assert.equal(o.calls.close, 2); assert.equal(o.el.scrim.hidden, true);
  await o.open(); const tab = await o.key('Tab');
  assert.equal(tab.defaultPrevented, true); assert.equal(o.calls.close, 3);
});

test('overlay mouse: hover activates, click chooses, a click on the scrim closes, a click inside the panel does not', async () => {
  const o = mountOverlay();
  await o.open();
  await o.rows()[0].fire('mousemove');
  assert.equal(o.activeId(), 'opt-w1');
  assert.ok(!o.el.list.classList.contains('is-keyboard'));
  await o.el.scrim.fire('mousedown', { target: o.el.panel });
  assert.equal(o.calls.close, 0);
  await o.el.scrim.fire('mousedown', { target: o.el.scrim });
  assert.equal(o.calls.close, 1);
  await o.open();
  await o.rows()[2].fire('click');
  assert.deepEqual(o.calls.choose, [{ session: 'contextdeck', workspaceId: 'w3' }]);
});

test('overlay: rapid choices send a single command; failures stay visible in the menu; stale results just close', async () => {
  const o = mountOverlay();
  await o.open();
  let release; const slow = new Promise((r) => { release = r; });
  o.setChooseResult(() => slow);
  const first = o.key('Enter'); const second = o.key('Enter'); const third = o.rows()[0].fire('click');
  assert.equal(o.calls.choose.length, 1, 'only one request while the first is pending');
  assert.match(o.el.message.textContent, /Trocando/);
  release({ ok: false, error: { code: 'busy', message: 'Uma troca de workspace ainda esta em andamento.' } });
  await Promise.all([first, second, third]);
  assert.match(o.el.message.textContent, /Falha: Uma troca de workspace ainda esta em andamento\./);
  assert.ok(o.el.message.classList.contains('is-error'));
  assert.equal(o.el.scrim.hidden, false, 'stays open so another workspace can be chosen');
  assert.equal(o.calls.close, 0);
  o.setChooseResult({ ok: false, stale: true, error: { code: 'stale', message: 'x' } });
  await o.key('Enter');
  assert.equal(o.calls.close, 1);
});

test('overlay: disconnected state disables choosing and says why', async () => {
  const o = mountOverlay(state({ connection: 'disconnected', canSelect: false }));
  await o.open();
  assert.equal(o.rows()[0].getAttribute('aria-disabled'), 'true');
  await o.key('Enter');
  assert.deepEqual(o.calls.choose, []);
});

test('overlay: long lists get a search box that filters (accents ignored); no match is explained; pushes keep the query', async () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: `w${i + 1}`, label: i === 4 ? 'Relatório' : `proj${i + 1}` }));
  const o = mountOverlay(state({ options: many, selected: { workspaceId: 'w1', origin: 'dock' } }));
  await o.open();
  assert.equal(o.el.search.hidden, false);
  assert.equal(o.document.activeElement, o.el.search);
  o.el.search.value = 'relatorio'; await o.el.search.fire('input');
  assert.deepEqual(o.rows().map((r) => r.id), ['opt-w5']);
  assert.equal(o.activeId(), 'opt-w5');
  o.pushState(state({ options: many, selected: { workspaceId: 'w1', origin: 'dock' }, observedId: 'w1' }));
  assert.deepEqual(o.rows().map((r) => r.id), ['opt-w5'], 'a state push keeps the filter');
  o.el.search.value = 'zzz'; await o.el.search.fire('input');
  assert.equal(o.rows().length, 1);
  assert.match(o.rows()[0].textContent, /Nenhum workspace corresponde/);
  await o.key('Enter');
  assert.deepEqual(o.calls.choose, [], 'Enter with no match does nothing');
});

test('overlay: closed from the main process hides the page; an unavailable saved workspace is explained', async () => {
  const o = mountOverlay(state({ selected: null, unavailableId: 'w9' }));
  await o.open();
  assert.match(o.el.message.textContent, /w9 não existe mais/);
  await o.openCb(null);
  assert.equal(o.el.scrim.hidden, true);
});

// ---- feedback and header ------------------------------------------------------------------------------------

test('feedback: one status line with an error level; unchanged text is not rewritten', () => {
  const document = createDocument(['status']);
  const { createFeedback } = load(path.join(SRC, 'components', 'feedback.js'), { document });
  const status = document.getElementById('status');
  const f = createFeedback(status);
  f.notice('Pronto'); assert.equal(status.textContent, 'Pronto'); assert.equal(status.getAttribute('data-level'), 'info');
  f.error('Falhou'); assert.equal(status.getAttribute('data-level'), 'error');
  f.notice('ok'); assert.equal(status.getAttribute('data-level'), 'info');
});

test('header: mode switches tabs and mode-dependent controls; every control calls the bridge exactly once', async () => {
  const document = createDocument(['app', 'tab-terminal', 'tab-chat', 'reconnect-terminal', 'chat-home', 'reload-chat', 'external-chat']);
  const { initHeader } = load(path.join(SRC, 'components', 'header.js'), { document });
  const calls = [];
  const dock = { switchTo: async (m) => calls.push(['switch', m]), chatHome: async () => calls.push(['home']), reloadChat: async () => calls.push(['reload']), openExternalChat: async () => calls.push(['external']) };
  let reconnects = 0;
  const header = initHeader({ dock, onReconnect: () => { reconnects += 1; } });
  header.setMode('chat');
  assert.equal(header.getMode(), 'chat');
  assert.equal(document.getElementById('tab-chat').getAttribute('aria-selected'), 'true');
  assert.equal(document.getElementById('tab-terminal').getAttribute('aria-selected'), 'false');
  header.setMode('bogus'); assert.equal(header.getMode(), 'chat');
  for (const id of ['tab-terminal', 'tab-chat', 'reconnect-terminal', 'chat-home', 'reload-chat', 'external-chat']) await document.getElementById(id).fire('click');
  assert.deepEqual(calls, [['switch', 'terminal'], ['switch', 'chat'], ['home'], ['reload'], ['external']]);
  assert.equal(reconnects, 1);
});

test('header markup: plain brand, Terminal/ChatGPT segmented switch, no session chip, unlinked hint only in chat', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const bar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(bar, /<div class="brand">ContextDeck<\/div>/);
  assert.doesNotMatch(bar, /M00|session-chip|session-name|Herdr: /);
  assert.match(bar, /id="tab-terminal" class="segment"[^>]*>Terminal</);
  assert.match(bar, /id="tab-chat" class="segment"[^>]*>ChatGPT</);
  assert.match(bar, /<button id="chat-link" class="unlinked chat-link chat-only"/);
  const order = ['brand', 'segmented', 'class="ws"', 'id="ws-mode"', 'view-actions', 'unlinked'].map((k) => bar.indexOf(k));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'header hierarchy order');
  assert.ok(order.every((i) => i >= 0));
});
