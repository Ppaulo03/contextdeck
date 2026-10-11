'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createDocument, load } = require('./helpers/fake-dom');
const view = require('../src/shared/activity-view');
const { registerActivityIpc, startActivityPusher } = require('../src/main/ipc/activity');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const totals = (over = {}) => ({ responding: 0, attention: 0, drafts: 0, observed: 0, loaded: 0, ...over });
const item = (n, over = {}) => ({ viewId: `v${n}`, bindingId: `b_${String(n).padStart(16, '0')}`, kind: 'binding', label: `chat ${n}`, responding: false, attention: false, draft: false, status: 'linked', needsConfirm: false, openable: true, ...over });
const group = (id, label, items) => ({ id, key: `contextdeck/${id}`, label, items });
const payload = (over = {}) => ({
  global: {
    totals: totals({ responding: 2, attention: 1, drafts: 1, observed: 4, loaded: 5 }), selectedId: 'w4',
    groups: [group('w4', 'Bicho', [item(1, { responding: true }), item(2, { attention: true }), item(3, { draft: true })]), group('w7', 'RelayPlane', [item(4, { responding: true })])]
  },
  notices: { items: [], more: 0 }, ...over
});

// ---- view-models --------------------------------------------------------------------------------------------------------

test('indicator model: counts of responding / to review / draft across ALL workspaces, neutral when quiet, honest about what is observed', () => {
  const m = view.indicatorModel(payload());
  assert.equal(m.text, '↻2 ●1 ✎1');
  assert.deepEqual(m.parts.map((p) => p.kind), ['responding', 'attention', 'draft']);
  assert.equal(m.idle, false);
  assert.equal(m.attention, true);
  assert.match(m.aria, /2 conversas respondendo, 1 conversa com atividade para revisar, 1 conversa com rascunho/);
  assert.match(m.title, /4 conversas observadas de 5 carregadas/);
  const quiet = view.indicatorModel({ global: { totals: totals({ observed: 2, loaded: 2 }), groups: [], selectedId: null } });
  assert.deepEqual([quiet.idle, quiet.text, quiet.attention], [true, '', false]);
  assert.match(quiet.title, /Nenhuma atividade observada.*2 conversas observadas/);
  const nothing = view.indicatorModel({ global: { totals: totals(), groups: [], selectedId: null } });
  assert.match(nothing.title, /Nenhuma conversa carregada: conversas que você ainda não abriu não são observadas/);
  assert.doesNotMatch(nothing.title + nothing.aria, /ocios|ociosa|livre/i, 'never says idle/free');
  assert.equal(view.indicatorModel(null).ready, false);
  assert.doesNotMatch(JSON.stringify([m, quiet]), /conclu[ií]d/i, 'never "concluída"');
});

test('center model: grouped by workspace with name AND id (homonyms apart), states in words, current workspace marked', () => {
  const p = payload();
  p.global.groups.push(group('w9', 'RelayPlane', [item(5, { responding: true })]));
  const m = view.centerModel(p);
  assert.deepEqual(m.groups.map((g) => g.title), ['Bicho · w4', 'RelayPlane · w7', 'RelayPlane · w9']);
  assert.deepEqual(m.groups.map((g) => g.current), [true, false, false]);
  assert.deepEqual(m.groups[0].items.map((i) => i.stateText), ['Respondendo', 'Atividade para revisar', 'Rascunho não enviado']);
  assert.ok(m.groups[0].items.every((i) => i.aria.includes('Bicho · w4')));
  assert.equal(m.groups[0].items[0].buttonLabel, 'Abrir');
  assert.equal(m.empty, '');
  assert.doesNotMatch(JSON.stringify(m), /conclu[ií]d/i);
});

test('center model: unverified items need a second step; orphans and unscoped pages cannot be opened; empty states are explained', () => {
  const p = { global: { totals: totals({ attention: 3, observed: 3, loaded: 3 }), selectedId: 'w1', groups: [
    group('w1', 'api', [item(1, { attention: true, status: 'suspect', needsConfirm: true }), item(2, { attention: true, status: 'orphan', openable: false })]),
    { id: null, key: null, label: '', items: [item(3, { kind: 'temporary', bindingId: null, attention: true, openable: false })] }] } };
  const m = view.centerModel(p, 'v1');
  assert.equal(m.groups[0].items[0].armed, true);
  assert.equal(m.groups[0].items[0].buttonLabel, 'Confirmar e abrir');
  assert.match(m.groups[0].items[0].hint, /identidade deste workspace não foi verificada/);
  assert.equal(m.groups[0].items[1].openable, false);
  assert.equal(m.groups[1].title, 'Fora de um workspace');
  assert.equal(m.groups[1].items[0].openable, false);
  assert.equal(view.centerModel(view.centerModel(p) && p, null).groups[0].items[0].armed, false);
  assert.match(view.centerModel({ global: { totals: totals(), groups: [] } }).empty, /Nenhuma conversa carregada/);
  assert.match(view.centerModel({ global: { totals: totals({ loaded: 2, observed: 2 }), groups: [] } }).empty, /Nenhuma atividade nas conversas observadas/);
});

test('notice model: "Atividade para revisar", never "concluída"; the target carries ids only; overflow is counted', () => {
  const n = view.noticesModel({ notices: { items: [{ id: 'n:v1', viewId: 'v1', workspaceId: 'w4', workspaceLabel: 'Bicho', label: 'Code Review', bindingId: 'b_0000000000000001', kind: 'binding', openable: true }, { id: 'n:v2', viewId: 'v2', workspaceId: 'w7', workspaceLabel: 'RelayPlane', label: 'Nova conversa', bindingId: null, kind: 'temporary', openable: true }], more: 2 } });
  assert.equal(n.items[0].title, 'Atividade para revisar');
  assert.equal(n.items[0].subtitle, 'Bicho · w4 · Code Review');
  assert.deepEqual(n.items[0].target, { workspaceId: 'w4', bindingId: 'b_0000000000000001' });
  assert.deepEqual(n.items[1].target, { workspaceId: 'w7', viewId: 'v2' });
  assert.equal(n.moreText, '+2 avisos (veja a central de atividade)');
  assert.doesNotMatch(JSON.stringify(n), /conclu[ií]d|https?:/i);
  assert.deepEqual(view.noticesModel(null), { items: [], more: 0, moreText: '' });
});

// ---- IPC ----------------------------------------------------------------------------------------------------------------------

function ipcSetup() {
  const handlers = new Map();
  const calls = { open: [], dismissed: [] };
  registerActivityIpc({
    ipcMain: { handle: (c, fn) => { assert.ok(!handlers.has(c)); handlers.set(c, fn); } },
    trustedUi: (e) => e.ui === true, trustedOverlay: (e) => e.overlay === true,
    getPayload: () => payload(),
    directOpen: { open: async (a) => { calls.open.push(a); return { ok: true }; } },
    notices: { dismiss: (id) => calls.dismissed.push(id) }
  });
  return { handlers, calls };
}

test('IPC: state for the UI window and the overlay; open and dismiss only for the overlay; strangers get nothing', async () => {
  const { handlers, calls } = ipcSetup();
  assert.deepEqual([...handlers.keys()].sort(), ['activity:dismiss', 'activity:open', 'activity:open-unbound', 'activity:state']);
  assert.ok(await handlers.get('activity:state')({ ui: true }));
  assert.ok(await handlers.get('activity:state')({ overlay: true }));
  assert.equal(await handlers.get('activity:state')({}), null);
  const args = { workspaceId: 'w4', bindingId: 'b_0000000000000001' };
  for (const sender of [{ ui: true }, {}]) {
    assert.equal((await handlers.get('activity:open')(sender, args)).error.code, 'untrusted');
    assert.equal((await handlers.get('activity:dismiss')(sender, { id: 'n:v1' })).error.code, 'untrusted');
  }
  assert.deepEqual([calls.open, calls.dismissed], [[], []]);
});

test('IPC open: exactly one of bindingId / viewId, validated formats, only the picked fields reach the flow, confirm only as boolean true', async () => {
  const { handlers, calls } = ipcSetup();
  const open = (args) => handlers.get('activity:open')({ overlay: true }, args);
  assert.equal((await open({ workspaceId: 'w4', bindingId: 'b_0000000000000001', url: 'https://evil.example', method: 'workspace.close', confirm: 'yes' })).ok, true);
  assert.deepEqual(calls.open, [{ workspaceId: 'w4', bindingId: 'b_0000000000000001', confirm: false }], 'nothing but the ids and the flag');
  assert.equal((await open({ workspaceId: 'w4', viewId: 'v12', confirm: true })).ok, true);
  assert.deepEqual(calls.open[1], { workspaceId: 'w4', viewId: 'v12', confirm: true });
  const before = calls.open.length;
  for (const bad of [undefined, null, 'x', 7, [], {}, { workspaceId: 'w4' }, { workspaceId: 'w4', bindingId: 'b_0000000000000001', viewId: 'v1' }, { workspaceId: '../w4', bindingId: 'b_0000000000000001' }, { workspaceId: 7, bindingId: 'b_0000000000000001' }, { workspaceId: 'w4', bindingId: 'nope' }, { workspaceId: 'w4', viewId: 'x1' }, { workspaceId: 'w4', bindingId: { toString: () => 'b_0000000000000001' } }]) {
    assert.equal((await open(bad)).error.code, 'invalid_request', JSON.stringify(bad));
  }
  assert.equal(calls.open.length, before);
  assert.equal((await handlers.get('activity:dismiss')({ overlay: true }, { id: 'n:v3' })).ok, true);
  assert.deepEqual(calls.dismissed, ['n:v3']);
  for (const bad of [undefined, {}, { id: 'v3' }, { id: 7 }, { id: 'n:../x' }]) assert.equal((await handlers.get('activity:dismiss')({ overlay: true }, bad)).error.code, 'invalid_request');
});

test('activity pusher: leading push, coalesced bursts, only changed content, silent after stop', () => {
  const sent = []; const timers = []; let t = 0; let state = { n: 1 };
  const p = startActivityPusher({ getPayload: () => state, send: (d) => sent.push(d), scheduler: { setTimeout: (fn) => { const x = { fn }; timers.push(x); return x; }, clearTimeout: (x) => { const i = timers.indexOf(x); if (i >= 0) timers.splice(i, 1); } }, now: () => t, intervalMs: 120 });
  p.notify();
  assert.deepEqual(sent, [{ n: 1 }]);
  t = 10; p.notify(); p.notify();
  assert.equal(timers.length, 1);
  t = 200; timers.shift().fn();
  assert.equal(sent.length, 1, 'unchanged: not re-sent');
  state = { n: 2 }; t = 500; p.notify();
  assert.equal(sent.length, 2);
  p.stop();
  state = { n: 3 }; t = 900; p.notify();
  assert.equal(sent.length, 2);
});

// ---- the top-bar indicator ----------------------------------------------------------------------------------------------------

function mountIndicator(initial = payload()) {
  const document = createDocument(['activity-indicator', 'activity-text']);
  const button = document.getElementById('activity-indicator');
  button.setAttribute('aria-expanded', 'false');
  const { initActivityIndicator } = load(path.join(SRC, 'components', 'activity-indicator.js'), { document });
  const calls = { open: [], errors: [] };
  let stateCb; let closedCb; let openResult = { ok: true }; let reads = 0;
  const dock = {
    openActivityCenter: async (a) => { calls.open.push(a); return openResult; },
    onActivityState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
    onOverlayClosed: (cb) => { closedCb = cb; return () => { closedCb = null; }; },
    activityState: async () => { reads += 1; return initial; }
  };
  const handle = initActivityIndicator({ dock, feedback: { error: (m) => calls.errors.push(m) } });
  return { document, button, slot: document.getElementById('activity-text'), calls, handle, push: (s) => stateCb(s), closed: (k) => closedCb(k), reads: () => reads, off: () => stateCb === null, setOpenResult: (r) => { openResult = r; }, tick: () => new Promise((r) => setImmediate(r)) };
}

test('indicator: shows the global counts with shapes and numbers, accessible name and tooltip, neutral when quiet, one initial read', async () => {
  const t = mountIndicator();
  await t.tick();
  assert.equal(t.reads(), 1);
  assert.equal(t.slot.textContent, '\u21BB2\u25CF1\u270E1');
  assert.deepEqual(t.slot.children.map((c) => c.className), ['act-part is-responding', 'act-part is-attention', 'act-part is-draft']);
  assert.equal(t.slot.children[0].children[0].textContent, '↻');
  assert.ok(t.slot.children[0].children[0].classList.contains('is-spin'));
  assert.match(t.button.getAttribute('aria-label'), /2 conversas respondendo/);
  assert.match(t.button.title, /Clique para ver todos os workspaces/);
  assert.ok(t.button.classList.contains('has-attention'));
  t.push({ global: { totals: totals({ observed: 1, loaded: 1 }), groups: [], selectedId: 'w1' }, notices: { items: [], more: 0 } });
  assert.ok(t.button.classList.contains('is-idle') && !t.button.classList.contains('has-attention'));
  assert.equal(t.slot.textContent, '○Atividade');
  assert.match(t.button.getAttribute('aria-label'), /nenhuma atividade observada/);
});

test('indicator: an update with the same content does not rebuild the DOM (no flicker)', async () => {
  const t = mountIndicator();
  await t.tick();
  const first = t.slot.children[0];
  t.push(payload());
  t.push(payload({ notices: { items: [{ id: 'n:v1' }], more: 0 } }));
  assert.equal(t.slot.children[0], first, 'same nodes: nothing was re-created');
  t.push({ ...payload(), global: { ...payload().global, totals: totals({ responding: 3, attention: 1, drafts: 1, observed: 4, loaded: 5 }) } });
  assert.notEqual(t.slot.children[0], first);
});

test('indicator: opens the activity center under itself from any tab, reports a failure, and gets focus back only when THAT overlay closes', async () => {
  const t = mountIndicator();
  await t.tick();
  await t.button.fire('click');
  assert.deepEqual(t.calls.open, [{ x: 100, y: 20, width: 200, height: 26 }]);
  assert.equal(t.button.getAttribute('aria-expanded'), 'true');
  t.closed('workspaces'); t.closed('chats');
  assert.equal(t.button.getAttribute('aria-expanded'), 'true', 'other overlays closing are not its business');
  t.closed('activity');
  assert.equal(t.button.getAttribute('aria-expanded'), 'false');
  assert.equal(t.button.focusCount, 1);
  t.setOpenResult({ ok: false });
  await t.button.fire('click');
  assert.match(t.calls.errors[0], /central de atividade/);
  t.handle.dispose();
  assert.equal(t.off(), true);
});

test('markup and styles: the indicator is a button in the top bar for BOTH tabs, has a fixed minimum size and compacts on narrow windows', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  const bar = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(bar, /<button id="activity-indicator" class="activity-ind is-idle" type="button" aria-haspopup="dialog"/);
  assert.doesNotMatch(bar.slice(bar.indexOf('id="activity-indicator"'), bar.indexOf('</button>', bar.indexOf('id="activity-indicator"'))), /chat-only|terminal-only/, 'not tied to a tab');
  const order = ['id="ws-mode"', 'id="activity-indicator"', 'view-actions'].map((k) => bar.indexOf(k));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'after the workspace selector, before the contextual actions');
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  assert.match(css, /\.activity-ind\s*\{[^}]*min-width: 96px/);
  const layout = fs.readFileSync(path.join(SRC, 'styles', 'layout.css'), 'utf8');
  assert.match(layout, /max-width: 1000px\)[^}]*\.topbar \.act-label \{ display: none; \}[\s\S]*\.topbar \.activity-ind \{ min-width: 52px;/, 'higher specificity than the base rule, which is bundled after layout.css');
  const overlayHtml = fs.readFileSync(path.join(SRC, 'overlay', 'overlay.html'), 'utf8');
  for (const id of ['activity', 'activity-title', 'activity-body', 'activity-message', 'activity-close', 'conflict', 'conflict-title', 'conflict-text', 'conflict-actions', 'conflict-message', 'notices']) assert.match(overlayHtml, new RegExp(`id="${id}"`));
  assert.match(overlayHtml, /id="notices" class="notices" aria-live="polite"/);
});

// ---- the overlay: activity center and notices -------------------------------------------------------------------------------------

function mountOverlay(initial = payload()) {
  const document = createDocument(['scrim', 'menu', 'menu-search', 'menu-list', 'menu-message', 'chats', 'chats-body', 'chats-message', 'chats-close', 'activity', 'activity-body', 'activity-message', 'activity-close', 'conflict', 'conflict-title', 'conflict-text', 'conflict-actions', 'conflict-message', 'notices']);
  for (const id of ['scrim', 'chats', 'chats-message', 'activity', 'activity-message', 'notices']) document.getElementById(id).hidden = true;
  let current = initial; let openCb; let pushCb;
  const calls = { open: [], dismiss: [], close: 0 };
  let openResult = { ok: true }; let gate = null;
  const window = {
    innerWidth: 1200,
    overlay: {
      getState: async () => ({}), choose: async () => ({ ok: true }), close: async () => { calls.close += 1; },
      onConflict: () => () => {}, onOpen: (cb) => { openCb = cb; return () => {}; }, onState: () => () => {}, onChatsState: () => () => {}, onActivityState: (cb) => { pushCb = cb; return () => {}; },
      chatsState: async () => null, chatsBind: async () => ({ ok: false }), chatsUpdate: async () => ({ ok: false }), chatsUnbind: async () => ({ ok: false }), chatsReassign: async () => ({ ok: false }),
      activityState: async () => current,
      activityOpen: async (a) => { calls.open.push(a); if (gate) await gate; return typeof openResult === 'function' ? openResult(a) : openResult; },
      activityDismiss: async (a) => { calls.dismiss.push(a); return { ok: true }; }
    }
  };
  load(path.join(SRC, 'overlay', 'overlay.js'), { document, window });
  const get = (id) => document.getElementById(id);
  const collect = (root, out = []) => { for (const c of root.children) { out.push(c); collect(c, out); } return out; };
  return {
    document, calls, get, scrim: get('scrim'), panel: get('activity'), notices: get('notices'), message: get('activity-message'),
    all: () => collect(get('activity-body')), text: () => get('activity-body').textContent,
    buttons: () => collect(get('activity-body')).filter((n) => n.tag === 'button' && !String(n.dataset.key || '').startsWith('unbound')),
    allButtons: () => collect(get('activity-body')).filter((n) => n.tag === 'button'),
    openCenter: async () => { await openCb({ x: 900, y: 20, width: 100, height: 26, kind: 'activity' }); },
    openNotices: async () => { await openCb({ kind: 'notice' }); },
    close: async () => { await openCb(null); },
    push: (s) => { current = s; pushCb(s); },
    setOpenResult: (r) => { openResult = r; }, setGate: (g) => { gate = g; },
    click: async (n) => { await n.fire('click'); await new Promise((r) => setImmediate(r)); },
    key: (k) => document.fire('keydown', { key: k })
  };
}

test('activity center: opens modal under the indicator, lists every workspace grouped with states in words and an Abrir per item; first button focused', async () => {
  const o = mountOverlay();
  await o.openCenter();
  assert.equal(o.scrim.hidden, false);
  assert.equal(o.panel.hidden, false);
  assert.equal(o.get('menu').hidden, true);
  assert.equal(o.get('chats').hidden, true);
  assert.equal(o.notices.hidden, true, 'the notices give way to the modal');
  assert.match(o.text(), /Bicho · w4/);
  assert.match(o.text(), /RelayPlane · w7/);
  assert.match(o.text(), /chat 1/);
  assert.match(o.text(), /Respondendo/);
  assert.match(o.text(), /Atividade para revisar/);
  assert.match(o.text(), /Rascunho não enviado/);
  assert.equal(o.buttons().length, 4);
  assert.equal(o.document.activeElement, o.buttons()[0]);
  assert.equal(o.panel.style.top, '50px');
  assert.doesNotMatch(o.text(), /conclu[ií]d/i);
});

test('activity center: Esc and a click outside close it; arrows, Home and End move between the Abrir buttons', async () => {
  const o = mountOverlay();
  await o.openCenter();
  const b = o.buttons();
  await o.key('ArrowDown'); assert.equal(o.document.activeElement, b[1]);
  await o.key('End'); assert.equal(o.document.activeElement, b[3]);
  await o.key('ArrowDown'); assert.equal(o.document.activeElement, b[3], 'does not wrap');
  await o.key('Home'); assert.equal(o.document.activeElement, b[0]);
  await o.key('ArrowUp'); assert.equal(o.document.activeElement, b[0]);
  await o.key('Escape');
  assert.equal(o.calls.close, 1);
  assert.equal(o.panel.hidden, true);
  assert.equal(o.scrim.hidden, true);
  await o.openCenter();
  await o.scrim.fire('mousedown', { target: o.scrim });
  assert.equal(o.calls.close, 2, 'a click outside the panel closes it');
  assert.equal(o.calls.open.length, 0, 'closing never opens or acknowledges anything');
});

test('activity center: Abrir sends only the ids of that item and closes on success; failures stay visible; a superseded request is silent', async () => {
  const o = mountOverlay();
  await o.openCenter();
  await o.click(o.buttons()[0]);
  assert.deepEqual(o.calls.open, [{ workspaceId: 'w4', bindingId: 'b_0000000000000001', confirm: false }]);
  assert.equal(o.calls.close, 1);
  await o.openCenter();
  o.setOpenResult({ ok: false, error: { code: 'focus_failed', message: 'Nao foi possivel trocar de workspace: x. A conversa nao foi aberta.' } });
  await o.click(o.buttons()[3]);
  assert.deepEqual(o.calls.open[1], { workspaceId: 'w7', bindingId: 'b_0000000000000004', confirm: false });
  assert.match(o.message.textContent, /A conversa nao foi aberta/);
  assert.ok(o.message.classList.contains('is-error'));
  assert.equal(o.calls.close, 1, 'a failed open keeps the center open');
  o.setOpenResult({ ok: false, superseded: true });
  await o.click(o.buttons()[1]);
  assert.equal(o.message.hidden, true);
  assert.equal(o.calls.close, 1);
});

test('activity center: an item that needs confirmation arms on the first click (nothing sent) and opens on the second with confirm: true', async () => {
  const p = payload();
  p.global.groups[0].items[0] = item(1, { responding: true, status: 'suspect', needsConfirm: true });
  const o = mountOverlay(p);
  await o.openCenter();
  await o.click(o.buttons()[0]);
  assert.equal(o.calls.open.length, 0);
  assert.equal(o.buttons()[0].textContent, 'Confirmar e abrir');
  await o.click(o.buttons()[0]);
  assert.deepEqual(o.calls.open, [{ workspaceId: 'w4', bindingId: 'b_0000000000000001', confirm: true }]);
  // The server may also ask for it.
  const o2 = mountOverlay();
  await o2.openCenter();
  o2.setOpenResult({ ok: false, error: { code: 'confirmation_required', message: 'A identidade deste workspace nao foi verificada. Confirme para abrir.' } });
  await o2.click(o2.buttons()[1]);
  assert.equal(o2.buttons()[1].textContent, 'Confirmar e abrir');
  assert.match(o2.message.textContent, /Confirme para abrir/);
});

test('activity center: while a request is in flight the buttons are disabled (no double opening); unopenable items are disabled', async () => {
  const p = payload();
  p.global.groups[1].items[0] = item(4, { responding: true, openable: false, status: 'orphan' });
  const o = mountOverlay(p);
  await o.openCenter();
  assert.equal(o.buttons()[3].disabled, true);
  let release; o.setGate(new Promise((r) => { release = r; }));
  const click = o.click(o.buttons()[0]);
  await new Promise((r) => setImmediate(r));
  assert.ok(o.buttons().every((b) => b.disabled), 'busy: nothing else can be clicked');
  await o.buttons()[1].fire('click');
  release(); await click;
  assert.equal(o.calls.open.length, 1);
});

test('activity center: updates while it is open re-render in place and keep the focused button; stale states disappear', async () => {
  const o = mountOverlay();
  await o.openCenter();
  await o.key('ArrowDown');
  const focused = o.document.activeElement.dataset.key;
  const next = payload();
  next.global.groups[0].items = next.global.groups[0].items.filter((i) => i.viewId !== 'v3');
  o.push(next);
  assert.equal(o.document.activeElement.dataset.key, focused);
  assert.doesNotMatch(o.text(), /chat 3/);
  o.push({ ...payload(), global: { totals: totals({ loaded: 2, observed: 2 }), selectedId: 'w4', groups: [] } });
  assert.match(o.text(), /Nenhuma atividade nas conversas observadas/);
  assert.equal(o.buttons().length, 0);
});

test('activity center: labels are text, never markup', async () => {
  const p = payload();
  p.global.groups[0].items[0] = item(1, { label: '<img src=x onerror=alert(1)>', responding: true });
  const o = mountOverlay(p);
  await o.openCenter();
  assert.ok(o.all().every((n) => n.tag !== 'img'));
  assert.match(o.text(), /<img src=x onerror=alert\(1\)>/);
});

test('notices: small cards (status role), no scrim, no focus taken; Abrir conversa opens through the same flow; × dismisses without opening', async () => {
  const p = payload({ notices: { items: [{ id: 'n:v1', viewId: 'v1', workspaceId: 'w4', workspaceLabel: 'Bicho', label: 'Code Review', bindingId: 'b_0000000000000001', kind: 'binding', openable: true }, { id: 'n:v2', viewId: 'v2', workspaceId: 'w7', workspaceLabel: 'RelayPlane', label: 'Nova conversa', bindingId: null, kind: 'temporary', openable: true }], more: 3 } });
  const o = mountOverlay(p);
  const before = o.document.activeElement;
  await o.openNotices();
  assert.equal(o.notices.hidden, false);
  assert.equal(o.scrim.hidden, true, 'no scrim: clicks outside the cards go to whatever is below');
  assert.equal(o.panel.hidden, true);
  assert.equal(o.document.activeElement, before, 'the notices took no focus');
  const cards = o.notices.children.filter((c) => c.classList.contains('act-notice'));
  assert.equal(cards.length, 2);
  assert.ok(cards.every((c) => c.getAttribute('role') === 'status'));
  assert.match(o.notices.textContent, /● Atividade para revisar/);
  assert.match(o.notices.textContent, /Bicho · w4 · Code Review/);
  assert.match(o.notices.textContent, /\+3 avisos/);
  assert.doesNotMatch(o.notices.textContent, /conclu[ií]d/i);
  const buttons = (card) => card.children.flatMap((c) => c.children).filter((c) => c.tag === 'button');
  await o.click(buttons(cards[0])[0]);
  assert.deepEqual(o.calls.open, [{ workspaceId: 'w4', bindingId: 'b_0000000000000001' }]);
  await o.click(buttons(cards[1])[1]);
  assert.deepEqual(o.calls.dismiss, [{ id: 'n:v2' }]);
  assert.equal(o.calls.open.length, 1, 'dismissing opens nothing');
});

test('notices: a failed open shows the reason inside the card; pushes update the list; the notice page never leaks into the center and vice versa', async () => {
  const o = mountOverlay(payload({ notices: { items: [{ id: 'n:v1', viewId: 'v1', workspaceId: 'w4', workspaceLabel: 'Bicho', label: 'Code Review', bindingId: 'b_0000000000000001', kind: 'binding', openable: true }], more: 0 } }));
  await o.openNotices();
  o.setOpenResult({ ok: false, error: { code: 'not_available', message: 'O workspace desta conversa nao esta disponivel.' } });
  const card = o.notices.children[0];
  await o.click(card.children[1].children[0]);
  assert.match(o.notices.textContent, /O workspace desta conversa nao esta disponivel/);
  o.push(payload({ notices: { items: [], more: 0 } }));
  assert.equal(o.notices.children.length, 0);
  await o.openCenter();
  assert.equal(o.notices.hidden, true);
  assert.equal(o.panel.hidden, false);
  await o.close();
  assert.equal(o.panel.hidden, true);
  assert.equal(o.notices.hidden, true);
});

test('motion and layout: the only animation is the existing spinner keyframes, disabled for reduced motion; notice cards use tokens only', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  const overlayCss = fs.readFileSync(path.join(SRC, 'overlay', 'overlay.css'), 'utf8');
  assert.equal([...css.matchAll(/@keyframes/g)].length, 1);
  assert.doesNotMatch(overlayCss, /@keyframes|animation:|transition:/, 'notices appear without animation');
  assert.match(fs.readFileSync(path.join(SRC, 'styles', 'base.css'), 'utf8'), /prefers-reduced-motion: reduce[\s\S]*animation/);
  assert.doesNotMatch(overlayCss, /#[0-9a-fA-F]{3,8}\b|z-index:\s*\d/);
});
