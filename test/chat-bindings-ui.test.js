'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createDocument, load } = require('./helpers/fake-dom');
const view = require('../src/shared/chat-bindings-view');
const { ID, chatUrl } = require('./helpers/bindings-world');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const wsList = [{ id: 'w1', label: 'api', directory: 'C:\\a' }, { id: 'w2', label: 'app', directory: 'C:\\b' }, { id: 'w3', label: 'app', directory: 'C:\\c' }];

function binding(n, extra = {}) {
  const base = {
    bindingId: `b_${String(n).padStart(16, '0')}`, conversationKey: `c:${ID(n)}`, url: chatUrl(n), label: `chat ${n}`, role: 'general', origin: 'url',
    workspaceIdentity: { session: 'contextdeck', workspaceId: 'w1' }, createdAt: 1, updatedAt: 1, status: 'linked', workspaceLabel: 'api'
  };
  return { ...base, ...extra };
}

function chatsState(extra = {}) {
  return {
    session: 'contextdeck', store: { status: 'ok', notice: null, writable: true }, connection: 'connected',
    selected: { workspaceId: 'w1', origin: 'dock' }, pending: false, workspaces: wsList,
    current: { state: 'unbound', conversationKey: `c:${ID(9)}`, selectedId: 'w1' }, bindings: [], ...extra
  };
}

// ---- view-models ---------------------------------------------------------------------------------------------------

test('indicator: the four required states, tone and tooltips', () => {
  const here = view.indicatorModel(chatsState({ bindings: [binding(1)], current: { state: 'bound-here', conversationKey: `c:${ID(1)}`, binding: binding(1), selectedId: 'w1' } }));
  assert.deepEqual([here.kind, here.tone, here.text], ['bound-here', 'success', 'Vinculado: w1 · api']);
  const elsewhere = view.indicatorModel(chatsState({ current: { state: 'bound-elsewhere', binding: binding(2, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' }, workspaceLabel: 'app' }) } }));
  assert.deepEqual([elsewhere.kind, elsewhere.tone, elsewhere.text], ['bound-elsewhere', 'warning', 'Vinculado a w2 · app']);
  assert.match(elsewhere.title, /outro workspace/);
  const unbound = view.indicatorModel(chatsState());
  assert.deepEqual([unbound.kind, unbound.text], ['unbound', 'Chat sem vínculo']);
  const unknown = view.indicatorModel(chatsState({ current: { state: 'unknown', reason: 'new' } }));
  assert.deepEqual([unknown.kind, unknown.text], ['unknown', 'Identidade pendente']);
  assert.match(unknown.title, /primeira mensagem/);
  assert.equal(view.indicatorModel(null).kind, 'unknown');
  const orphan = view.indicatorModel(chatsState({ current: { state: 'bound-elsewhere', binding: binding(3, { status: 'orphan' }) } }));
  assert.equal(orphan.text, 'Vinculado a workspace ausente');
});

test('indicator: workspaces with the same name are told apart by id', () => {
  const a = view.indicatorModel(chatsState({ current: { state: 'bound-elsewhere', binding: binding(1, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' } }) } }));
  const b = view.indicatorModel(chatsState({ current: { state: 'bound-elsewhere', binding: binding(1, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w3' } }) } }));
  assert.notEqual(a.text, b.text);
});

test('panel model: rows of the destination, orphans, blocked reasons, confirmation need, notices', () => {
  const s = chatsState({ bindings: [binding(1, { role: 'review' }), binding(2, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' } }), binding(3, { status: 'orphan', workspaceIdentity: { session: 'contextdeck', workspaceId: 'w9' }, workspaceLabel: 'gone' })] });
  const m = view.panelModel(s);
  assert.deepEqual([m.targetId, m.targetText, m.targetNote], ['w1', 'w1 · api', 'escolhido no ContextDeck']);
  assert.deepEqual(m.rows.map((r) => r.label), ['chat 1']);
  assert.equal('roles' in m, false, 'the fixed category is gone from the model');
  assert.equal(m.estimated, false);
  assert.match(view.panelModel(chatsState({ selected: { workspaceId: 'w1', origin: 'herdr' } })).estimateText, /não foi confirmado como destino/);
  assert.deepEqual(m.orphans.map((o) => [o.label, o.workspace]), [['chat 3', 'w9 · gone']]);
  assert.equal(m.canWrite, true);
  assert.equal(m.needsConfirm, false);
  assert.equal(view.panelModel(s, 'w2').rows.length, 1, 'another destination lists its own bindings');
  assert.equal(view.panelModel(s, 'w2').needsConfirm, true, 'a destination other than the explicit one needs confirmation');
  assert.equal(view.panelModel(chatsState({ selected: { workspaceId: 'w1', origin: 'herdr' } })).needsConfirm, true);
  assert.equal(view.panelModel(chatsState({ selected: { workspaceId: 'w1', origin: 'herdr' }, workspaces: [wsList[0]] })).needsConfirm, false);
  assert.match(view.panelModel(chatsState({ connection: 'disconnected' })).blocked, /Herdr desconectado/);
  assert.match(view.panelModel(chatsState({ pending: true })).blocked, /Troca de workspace/);
  assert.match(view.panelModel(chatsState({ store: { status: 'unsupported', writable: false, notice: { message: 'versão mais nova' } } })).blocked, /somente leitura/);
  assert.equal(view.panelModel(chatsState({ store: { status: 'recovered', writable: true, notice: { message: 'copia preservada' } } })).storeNotice, 'copia preservada');
  assert.equal(view.panelModel(chatsState({ selected: null }), null).targetId, null);
  assert.match(view.panelModel(chatsState({ selected: null }), null).blocked, /Selecione/);
  assert.equal(view.panelModel(null).ready, false);
  assert.deepEqual(view.panelModel(chatsState({ current: { state: 'bound-here', binding: binding(1), conversationKey: `c:${ID(1)}` } })).canBindCurrent, false);
  assert.equal(view.panelModel(chatsState({ current: { state: 'unknown', reason: 'new' } })).canBindCurrent, false);
});

test('the view-model mirrors the service rule for confirmation', () => {
  assert.equal(view.needsTargetConfirmation(chatsState(), 'w1'), false);
  assert.equal(view.needsTargetConfirmation(chatsState(), 'w2'), true);
  assert.equal(view.needsTargetConfirmation(chatsState({ selected: { workspaceId: 'w1', origin: 'recovery' } }), 'w1'), true);
  assert.equal(view.needsTargetConfirmation(null, 'w1'), true);
});

// ---- the panel (overlay) --------------------------------------------------------------------------------------------

function mountPanel(initial = chatsState(), { results = {} } = {}) {
  const document = createDocument(['scrim', 'menu', 'menu-search', 'menu-list', 'menu-message', 'chats', 'chats-body', 'chats-message', 'chats-close', 'activity', 'activity-body', 'activity-message', 'activity-close', 'conflict', 'conflict-text', 'conflict-actions', 'conflict-message', 'notices']);
  document.getElementById('scrim').hidden = true;
  document.getElementById('chats').hidden = true;
  document.getElementById('chats-message').hidden = true;
  document.getElementById('activity').hidden = true;
  document.getElementById('activity-message').hidden = true;
  document.getElementById('notices').hidden = true;
  let current = initial;
  let openCb; let pushCb;
  const calls = { bind: [], update: [], unbind: [], reassign: [], projectsLink: [], projectsUnlink: [], close: 0 };
  const reply = (name, args) => (typeof results[name] === 'function' ? results[name](args) : (results[name] || { ok: true }));
  const window = {
    innerWidth: 1200,
    overlay: {
      getState: async () => ({}), choose: async () => ({ ok: true }), close: async () => { calls.close += 1; },
      onConflict: () => () => {}, onOpen: (cb) => { openCb = cb; return () => {}; }, onState: () => () => {}, onChatsState: (cb) => { pushCb = cb; return () => {}; },
      activityState: async () => null, activityOpen: async () => ({ ok: false }), activityDismiss: async () => ({ ok: true }), onActivityState: () => () => {},
      chatsState: async () => current,
      chatsBind: async (a) => { calls.bind.push(a); return reply('bind', a); },
      chatsUpdate: async (a) => { calls.update.push(a); return reply('update', a); },
      chatsUnbind: async (a) => { calls.unbind.push(a); return reply('unbind', a); },
      chatsReassign: async (a) => { calls.reassign.push(a); return reply('reassign', a); },
      projectsLink: async (a) => { calls.projectsLink.push(a); return reply('projectsLink', a); },
      projectsUnlink: async (a) => { calls.projectsUnlink.push(a); return reply('projectsUnlink', a); }
    }
  };
  load(path.join(SRC, 'overlay', 'overlay.js'), { document, window });
  const body = document.getElementById('chats-body');
  const all = () => body._all();
  const byKey = (key) => all().find((n) => n.dataset && n.dataset.key === key);
  const text = () => body.textContent;
  const buttons = () => all().filter((n) => n.tag === 'button');
  const button = (label) => buttons().find((b) => b.textContent === label);
  return {
    document, body, calls, byKey, text, buttons, button,
    panel: document.getElementById('chats'), menu: document.getElementById('menu'), scrim: document.getElementById('scrim'), message: document.getElementById('chats-message'),
    open: async (anchor = { x: 900, y: 20, width: 140, height: 24 }) => { await openCb({ ...anchor, kind: 'chats' }); },
    push: (s) => { current = s; pushCb(s); },
    setState: (s) => { current = s; },
    click: async (b) => { await b.fire('click'); await new Promise((r) => setImmediate(r)); },
    type: async (key, value) => { const n = byKey(key); n.value = value; await n.fire('input'); },
    key: (k) => document.fire('keydown', { key: k }),
    // The dropdowns of the panel: the trigger is `byKey(key)`; its list is the second child of the same wrapper.
    options: (key) => byKeyRows(byKey(key)),
    choose: async (key, value) => {
      const trigger = byKey(key);
      await trigger.fire('click');
      const row = byKeyRows(trigger).find((r) => r.dataset.value === value);
      await row.fire('click');
      await new Promise((r) => setImmediate(r));
    }
  };
}
const byKeyRows = (trigger) => trigger.parent.children[1].children[0].children;

test('panel opens in chats mode: the menu is hidden, the destination and its conversations are shown, positioned under the trigger', async () => {
  const s = chatsState({ bindings: [binding(1, { role: 'architecture' }), binding(2)] });
  const t = mountPanel(s);
  await t.open();
  assert.equal(t.scrim.hidden, false);
  assert.equal(t.panel.hidden, false);
  assert.equal(t.menu.hidden, true, 'the workspace menu is not shown in chats mode');
  assert.match(t.text(), /Destino w1 · api \(escolhido no ContextDeck\)/);
  const select = t.byKey('target');
  assert.equal(select.value, 'w1');
  assert.deepEqual(t.options('target').map((o) => o.textContent), ['w1 · api', 'w2 · app', 'w3 · app'], 'same rows as every other list');
  assert.equal(select.tag, 'button', 'no native <select>: its open list would look different');
  assert.match(t.text(), /chat 1/);
  assert.match(t.text(), /chat 2/);
  assert.equal(t.document.activeElement, select);
  assert.equal(t.panel.style.top, '48px');
  assert.equal(t.panel.style.left, '780px', 'right edge aligned with the trigger');
  await t.key('Escape');
  assert.equal(t.calls.close, 1);
  assert.equal(t.panel.hidden, true);
  assert.equal(t.scrim.hidden, true);
});

test('bind current: sends the destination shown, what was selected at open, and the typed label - never a URL, never a category', async () => {
  const t = mountPanel();
  await t.open();
  await t.type('label', 'Arquitetura base');
  assert.equal(t.byKey('role'), undefined, 'no category selector');
  assert.equal(t.byKey('confirm'), undefined, 'no confirmation checkbox');
  await t.click(t.button('Vincular conversa atual'));
  assert.deepEqual(t.calls.bind, [{ source: 'current', target: { session: 'contextdeck', workspaceId: 'w1' }, selectedAtOpen: 'w1', targetChosen: false, label: 'Arquitetura base' }]);
  assert.match(t.message.textContent, /Conversa vinculada/);
  assert.equal(t.byKey('label').value, '', 'the form is cleared after success');
});

test('bind current is disabled while the page has no persistent identity, and explains why', async () => {
  const t = mountPanel(chatsState({ current: { state: 'unknown', reason: 'new' } }));
  await t.open();
  assert.equal(t.button('Vincular conversa atual').disabled, true);
  assert.match(t.text(), /primeira mensagem/);
  assert.equal(t.calls.bind.length, 0);
});

test('bind by URL: needs text, sends source "url" and the typed address; main decides if it is valid', async () => {
  const t = mountPanel(undefined, { results: { bind: { ok: false, error: { code: 'foreign_host', message: 'Somente conversas de chatgpt.com podem ser vinculadas.' } } } });
  await t.open();
  assert.equal(t.button('Vincular por URL').disabled, true, 'empty input');
  await t.type('url', 'https://evil.example/c/x');
  await t.click(t.button('Vincular por URL'));
  assert.equal(t.calls.bind[0].source, 'url');
  assert.equal(t.calls.bind[0].url, 'https://evil.example/c/x');
  assert.equal(t.message.textContent, 'Somente conversas de chatgpt.com podem ser vinculadas.');
  assert.ok(t.message.classList.contains('is-error'));
});

test('an estimated destination is not proposed: the user picks a workspace (no checkbox) and then binds', async () => {
  const t = mountPanel(chatsState({ selected: { workspaceId: 'w1', origin: 'herdr' } }));
  await t.open();
  assert.match(t.text(), /O workspace atual \(w1 · api\) vem do foco do Herdr e não foi confirmado como destino/);
  assert.notEqual(t.byKey('target').value, 'w1', 'nothing preselected');
  assert.equal(t.button('Vincular conversa atual').disabled, true);
  assert.equal(t.byKey('confirm'), undefined);
  await t.choose('target', 'w1');
  assert.doesNotMatch(t.text(), /não foi confirmado como destino/);
  assert.equal(t.button('Vincular conversa atual').disabled, false);
  await t.click(t.button('Vincular conversa atual'));
  assert.equal(t.calls.bind.length, 1, 'one click, no confirmation loop');
  assert.equal(t.calls.bind[0].targetChosen, true);
  assert.equal('confirmTarget' in t.calls.bind[0], false);
});

test('choosing another destination in the panel is itself the confirmation; the list follows it', async () => {
  const s = chatsState({ bindings: [binding(1), binding(2, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' }, label: 'in w2' })] });
  const t = mountPanel(s);
  await t.open();
  await t.choose('target', 'w2');
  assert.match(t.text(), /in w2/);
  assert.doesNotMatch(t.text(), /chat 1/);
  assert.match(t.text(), /Destino w2 · app \(escolhido neste painel\)/);
  assert.equal(t.button('Vincular conversa atual').disabled, false);
  await t.click(t.button('Vincular conversa atual'));
  assert.deepEqual([t.calls.bind[0].target.workspaceId, t.calls.bind[0].selectedAtOpen, t.calls.bind[0].targetChosen], ['w2', 'w1', true]);
});

test('the selected workspace changes while the panel is open: a warning blocks writes until the destination is reviewed', async () => {
  const t = mountPanel();
  await t.open();
  t.push(chatsState({ selected: { workspaceId: 'w2', origin: 'herdr' } }));
  assert.match(t.text(), /mudou desde que este painel foi aberto/);
  assert.equal(t.button('Vincular conversa atual').disabled, true);
  assert.equal(t.calls.bind.length, 0);
  await t.click(t.button('Usar o selecionado agora'));
  assert.doesNotMatch(t.text(), /mudou desde que/);
  assert.notEqual(t.byKey('target').value, 'w2', 'the new selection is an estimate: not proposed');
  assert.equal(t.button('Vincular conversa atual').disabled, true, 'pick the destination first');
  await t.choose('target', 'w2');
  await t.click(t.button('Vincular conversa atual'));
  assert.deepEqual([t.calls.bind[0].target.workspaceId, t.calls.bind[0].selectedAtOpen], ['w2', 'w2']);
});

test('main refusing with context_changed is shown; the panel never retries by itself', async () => {
  const t = mountPanel(undefined, { results: { bind: { ok: false, error: { code: 'context_changed', message: 'O workspace selecionado mudou enquanto o formulario estava aberto. Revise o destino.' } } } });
  await t.open();
  await t.click(t.button('Vincular conversa atual'));
  assert.equal(t.calls.bind.length, 1);
  assert.match(t.message.textContent, /Revise o destino/);
});

test('conflict: shows where the conversation lives and offers an explicit reassignment; nothing moves on its own', async () => {
  const other = binding(1, { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w2' }, workspaceLabel: 'app', label: 'Plano' });
  const t = mountPanel(chatsState({ current: { state: 'bound-elsewhere', binding: other, conversationKey: other.conversationKey }, bindings: [other] }), { results: { bind: { ok: false, error: { code: 'conflict', message: 'x', binding: other } } } });
  await t.open();
  await t.click(t.button('Vincular conversa atual'));
  assert.match(t.text(), /já está vinculada a w2 · app como "Plano"/);
  assert.equal(t.calls.reassign.length, 0);
  await t.click(t.button('Reassociar para w1 · api'));
  assert.deepEqual(t.calls.reassign, [{ bindingId: other.bindingId, target: { session: 'contextdeck', workspaceId: 'w1' }, selectedAtOpen: 'w1', targetChosen: false, confirmReassign: true }]);
  assert.match(t.message.textContent, /reassociada/);
});

test('unbinding takes two deliberate clicks and says the conversation in ChatGPT is untouched', async () => {
  const t = mountPanel(chatsState({ bindings: [binding(1)] }));
  await t.open();
  await t.click(t.button('Desvincular'));
  assert.equal(t.calls.unbind.length, 0);
  await t.click(t.button('Não'));
  assert.ok(t.button('Desvincular'));
  await t.click(t.button('Desvincular'));
  await t.click(t.button('Confirmar'));
  assert.deepEqual(t.calls.unbind, [{ bindingId: binding(1).bindingId }]);
  assert.match(t.message.textContent, /não foi alterada/);
});

test('editing the label inline sends only the label (no category control)', async () => {
  const t = mountPanel(chatsState({ bindings: [binding(1, { label: 'old' })] }));
  await t.open();
  await t.click(t.button('Editar'));
  const id = binding(1).bindingId;
  await t.type(`edit-label-${id}`, 'new name');
  assert.equal(t.byKey(`edit-role-${id}`), undefined);
  await t.click(t.button('Salvar'));
  assert.deepEqual(t.calls.update, [{ bindingId: id, label: 'new name' }]);
});

test('orphans are listed with their old workspace and can be adopted into the destination or unbound', async () => {
  const orphan = binding(5, { status: 'orphan', workspaceIdentity: { session: 'contextdeck', workspaceId: 'w9' }, workspaceLabel: 'gone', label: 'lost chat' });
  const t = mountPanel(chatsState({ bindings: [orphan] }));
  await t.open();
  assert.match(t.text(), /Vínculos órfãos/);
  assert.match(t.text(), /lost chat/);
  assert.match(t.text(), /era de w9 · gone/);
  await t.click(t.button('Reassociar aqui'));
  assert.equal(t.calls.reassign[0].bindingId, orphan.bindingId);
  assert.equal(t.calls.reassign[0].confirmReassign, true);
  assert.ok(t.button('Desvincular'));
});

test('writes are disabled when Herdr is disconnected or a switch is pending, with the reason shown', async () => {
  for (const [patch, reason] of [[{ connection: 'disconnected' }, /Herdr desconectado/], [{ pending: true }, /Troca de workspace/], [{ store: { status: 'unsupported', writable: false, notice: { message: 'Somente leitura.' } } }, /somente leitura/]]) {
    const t = mountPanel(chatsState(patch));
    await t.open();
    assert.match(t.text(), reason);
    assert.equal(t.button('Vincular conversa atual').disabled, true);
  }
});

test('user and workspace text is always rendered as text, never as markup', async () => {
  const t = mountPanel(chatsState({ bindings: [binding(1, { label: '<img src=x onerror=alert(1)>' })], workspaces: [{ id: 'w1', label: '<b>x</b>', directory: '' }] }));
  await t.open();
  assert.ok(t.body._all().every((n) => n.tag !== 'img' && n.tag !== 'b'));
  assert.match(t.text(), /<img src=x onerror=alert\(1\)>/);
});

test('a push while typing keeps the draft and the focus', async () => {
  const t = mountPanel();
  await t.open();
  await t.type('label', 'half written');
  t.byKey('label').focus();
  t.push(chatsState({ bindings: [binding(1)] }));
  assert.equal(t.byKey('label').value, 'half written');
  assert.equal(t.document.activeElement, t.byKey('label'));
});

test('workspace menu still works after the chats panel (modes do not leak into each other)', async () => {
  const t = mountPanel();
  await t.open();
  await t.key('Escape');
  assert.equal(t.panel.hidden, true);
});

// ---- the top-bar indicator ----------------------------------------------------------------------------------------

function mountLink(initial = chatsState()) {
  const document = createDocument(['chat-link']);
  const button = document.getElementById('chat-link');
  button.setAttribute('aria-expanded', 'false');
  const { initChatLink } = load(path.join(SRC, 'components', 'chat-link.js'), { document });
  const calls = { open: [], errors: [] };
  let stateCb; let closedCb; let openResult = { ok: true }; let reads = 0;
  const dock = {
    openChatsPanel: async (a) => { calls.open.push(a); return openResult; },
    onChatsState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
    onOverlayClosed: (cb) => { closedCb = cb; return () => { closedCb = null; }; },
    chatsState: async () => { reads += 1; return initial; }
  };
  const handle = initChatLink({ dock, feedback: { error: (m) => calls.errors.push(m) } });
  return { button, calls, handle, push: (s) => stateCb(s), closed: (kind) => closedCb(kind), reads: () => reads, setOpenResult: (r) => { openResult = r; } };
}

test('indicator button: shows the real binding state, opens the panel under itself, gives focus back when it closes', async () => {
  const t = mountLink();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.reads(), 1);
  assert.equal(t.button.textContent, 'Chat sem vínculo');
  t.push(chatsState({ current: { state: 'bound-here', binding: binding(1), conversationKey: `c:${ID(1)}` } }));
  assert.equal(t.button.textContent, 'Vinculado: w1 · api');
  assert.ok(t.button.classList.contains('is-success'));
  t.push(chatsState({ current: { state: 'unknown', reason: 'new' } }));
  assert.equal(t.button.textContent, 'Identidade pendente');
  assert.ok(t.button.classList.contains('is-neutral') && !t.button.classList.contains('is-success'));
  await t.button.fire('click');
  assert.deepEqual(t.calls.open, [{ x: 100, y: 20, width: 200, height: 26 }]);
  assert.equal(t.button.getAttribute('aria-expanded'), 'true');
  t.closed('workspaces');
  assert.equal(t.button.getAttribute('aria-expanded'), 'true', 'the workspace menu closing is not its business');
  t.closed('chats');
  assert.equal(t.button.getAttribute('aria-expanded'), 'false');
  assert.equal(t.button.focusCount, 1);
  t.setOpenResult({ ok: false });
  await t.button.fire('click');
  assert.match(t.calls.errors[0], /painel de conversas/);
  t.handle.dispose();
  assert.equal(t.closed === undefined, false);
});

test('the workspace selector ignores the closing of the chats panel (and still handles its own menu)', async () => {
  const document = createDocument(['ws-trigger', 'ws-trigger-text', 'ws-activity', 'ws-mode']);
  const { initWorkspaceSelector } = load(path.join(SRC, 'components', 'workspace-selector.js'), { document });
  let closedCb;
  const store = { get: () => null, subscribe: () => () => {} };
  initWorkspaceSelector({ dock: { onOverlayClosed: (cb) => { closedCb = cb; return () => {}; }, openWorkspaceMenu: async () => ({ ok: true }), herdrSetSyncMode: async () => ({}) }, store, feedback: { error() {} } });
  const trigger = document.getElementById('ws-trigger');
  closedCb('chats');
  assert.equal(trigger.focusCount, 0);
  closedCb('workspaces');
  assert.equal(trigger.focusCount, 1);
  closedCb();
  assert.equal(trigger.focusCount, 2, 'legacy payload-less close still restores focus');
});

test('markup: the indicator is a button in the top bar, chat-only, and the panel exists in the overlay page', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  assert.match(html, /<button id="chat-link" class="unlinked chat-link chat-only" type="button"/);
  const overlayHtml = fs.readFileSync(path.join(SRC, 'overlay', 'overlay.html'), 'utf8');
  for (const id of ['chats', 'chats-title', 'chats-body', 'chats-message', 'chats-close']) assert.match(overlayHtml, new RegExp(`id="${id}"`));
  assert.match(overlayHtml, /id="chats"[^>]*role="dialog"[^>]*aria-modal="true"/);
});

// ---- Project section (M01-I3B-3, experimental) ------------------------------------------------------------------------------------

const PID = `g-p-${'a'.repeat(32)}`;
const projectState = (extra = {}, records = []) => chatsState({ projectsEnabled: true, projects: { store: { status: 'ok', writable: true, notice: null }, records, current: { projectId: PID, url: `https://chatgpt.com/g/${PID}-x/project`, label: 'x', source: 'project-page', linkedTo: null } }, ...extra });

test('Project section: hidden unless main enables it', async () => {
  const t = mountPanel(chatsState());
  await t.open();
  assert.doesNotMatch(t.text(), /Project ChatGPT/);
  assert.equal(t.button('Vincular Project atual'), undefined);
});

test('Project section: link the current Project; nothing but the destination and choices is sent (no address)', async () => {
  const t = mountPanel(projectState());
  await t.open();
  assert.match(t.text(), /Nenhum Project vinculado a este workspace/);
  await t.click(t.button('Vincular Project atual'));
  assert.deepEqual(t.calls.projectsLink, [{ source: 'current', target: { session: 'contextdeck', workspaceId: 'w1' }, selectedAtOpen: 'w1', targetChosen: false }]);
  assert.match(t.message.textContent, /Project vinculado/);
});

test('Project section: a refused replacement waits for an explicit decision, then sends replace; unlink takes two clicks', async () => {
  const rec = { workspaceIdentity: { session: 'contextdeck', workspaceId: 'w1' }, projectId: `g-p-${'b'.repeat(32)}`, label: 'antigo', status: 'linked' };
  const t = mountPanel(projectState({}, [rec]), { results: { projectsLink: { ok: false, error: { code: 'project_already_linked', message: 'Este workspace ja tem outro Project vinculado. Substitua-o explicitamente.' } } } });
  await t.open();
  assert.match(t.text(), /Project: antigo/);
  await t.click(t.button('Trocar pelo Project atual'));
  assert.match(t.text(), /Substitua-o explicitamente/);
  assert.equal(t.calls.projectsLink.length, 1, 'no automatic retry');
  await t.click(t.button('Substituir'));
  assert.equal(t.calls.projectsLink[1].replace, true);
  await t.click(t.button('Remover vínculo'));
  assert.equal(t.calls.projectsUnlink.length, 0);
  await t.click(t.button('Confirmar'));
  assert.deepEqual(t.calls.projectsUnlink, [{ target: { session: 'contextdeck', workspaceId: 'w1' } }]);
});
