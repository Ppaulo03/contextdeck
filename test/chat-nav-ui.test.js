'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createDocument, load } = require('./helpers/fake-dom');
const { barModel } = require('../src/shared/chat-nav-view');

const SRC = path.join(__dirname, '..', 'src', 'renderer');
const IDS = ['chatbar-ws', 'chatbar-tabs', 'chatbar-new', 'chatbar-manage', 'chat-empty', 'chat-empty-title', 'chat-empty-text', 'chat-empty-new', 'chat-empty-manage'];

const tab = (n, extra = {}) => ({ bindingId: `b_${String(n).padStart(16, '0')}`, label: `chat ${n}`, role: 'general', status: 'linked', hint: '', loaded: false, loading: false, failed: false, active: false, needsConfirm: false, relation: null, ...extra });
const nav = (extra = {}) => ({
  mode: 'chat', workspace: { key: 'contextdeck/w1', id: 'w1', label: 'Bicho', origin: 'dock', pending: false },
  tabs: [tab(1, { active: true, loaded: true, relation: 'match' }), tab(2), tab(3)], temporaries: [], empty: null, activeViewId: 'v2', visibleRelation: 'match', duplicates: 0, ...extra
});

function mount(initial = nav()) {
  const document = createDocument(IDS);
  document.getElementById('chat-empty').hidden = true;
  const { initChatStrip } = load(path.join(SRC, 'components', 'chat-strip.js'), { document });
  const calls = { select: [], temp: [], create: [], unscoped: 0, panel: [], errors: [] };
  let stateCb; let results = {}; let reads = 0;
  const dock = {
    onChatNavState: (cb) => { stateCb = cb; return () => { stateCb = null; }; },
    chatNavState: async () => { reads += 1; return initial; },
    chatNavSelect: async (a) => { calls.select.push(a); return results.select || { ok: true }; },
    chatNavSelectTemporary: async (a) => { calls.temp.push(a); return results.temp || { ok: true }; },
    chatNavNew: async (a) => { calls.create.push(a); return results.create || { ok: true }; },
    chatNavOpenUnscoped: async () => { calls.unscoped += 1; return { ok: true }; }
  };
  const handle = initChatStrip({ dock, feedback: { error: (m) => calls.errors.push(m) }, openChatsPanel: (button) => calls.panel.push(button.id) });
  const get = (id) => document.getElementById(id);
  const tabs = () => get('chatbar-tabs').children.filter((c) => c.dataset && c.dataset.key);
  return {
    document, calls, handle, get, tabs, setResults: (r) => { results = r; }, reads: () => reads, off: () => stateCb === null,
    push: (s) => stateCb(s), tick: () => new Promise((r) => setImmediate(r)),
    click: async (node) => { await node.fire('click'); await new Promise((r) => setImmediate(r)); },
    texts: () => tabs().map((t) => t.textContent)
  };
}

// ---- view-model ---------------------------------------------------------------------------------------------------

test('bar model: title with the workspace, tab texts, homonym hints, warnings, armed confirmation', () => {
  const m = barModel(nav({ tabs: [tab(1, { label: 'Review', hint: 'a3f1', active: true }), tab(2, { label: 'Review', hint: '9bc2' }), tab(3, { status: 'suspect', needsConfirm: true }), tab(4, { failed: true }), tab(5, { relation: 'diverged' })] }), tab(3).bindingId);
  assert.equal(m.title, 'ChatGPT · Bicho');
  assert.deepEqual(m.tabs.map((t) => t.text), ['Review · a3f1', 'Review · 9bc2', 'Confirmar "chat 3"?', 'chat 4', 'chat 5']);
  assert.deepEqual(m.tabs.map((t) => t.warn), [false, false, true, true, true]);
  assert.match(m.tabs[2].title, /Clique duas vezes/);
  assert.match(m.tabs[3].title, /Falha ao carregar/);
  assert.match(m.tabs[4].title, /outra conversa/);
  assert.equal(m.tabs[0].active, true);
  assert.equal(barModel(nav({ workspace: { ...nav().workspace, label: '' } })).title, 'ChatGPT · w1', 'falls back to the id');
  assert.equal(barModel(nav({ workspace: null })).title, 'ChatGPT · sem workspace');
  assert.equal(barModel(nav({ workspace: null })).createLabel, 'Abrir ChatGPT');
  assert.equal(barModel(nav({ workspace: { ...nav().workspace, pending: true } })).canCreate, false);
  assert.equal(barModel(null).ready, false);
});

test('bar model: every empty reason has a title and text; no empty state when a view is shown', () => {
  for (const reason of ['no-workspace', 'no-conversations', 'select-conversation', 'not-verified']) {
    const m = barModel(nav({ empty: reason }));
    assert.equal(m.empty.reason, reason);
    assert.ok(m.empty.title && m.empty.text);
  }
  assert.equal(barModel(nav()).empty, null);
});

// ---- the strip ---------------------------------------------------------------------------------------------------

test('renders the conversations of the workspace with an accessible tablist (one selected, roving tabindex)', async () => {
  const t = mount();
  await t.tick();
  assert.equal(t.reads(), 1, 'one initial read');
  assert.equal(t.get('chatbar-ws').textContent, 'ChatGPT · Bicho');
  assert.deepEqual(t.texts(), ['chat 1', 'chat 2', 'chat 3']);
  assert.deepEqual(t.tabs().map((x) => x.getAttribute('aria-selected')), ['true', 'false', 'false']);
  assert.deepEqual(t.tabs().map((x) => x.tabIndex), [0, -1, -1]);
  assert.ok(t.tabs().every((x) => x.getAttribute('role') === 'tab'));
  assert.equal(t.get('chat-empty').hidden, true);
});

test('loading is a discreet spinner inside the tab; the layout does not change (same node count and text)', async () => {
  const t = mount(nav({ tabs: [tab(1, { active: true, loading: true })] }));
  await t.tick();
  const [first] = t.tabs();
  assert.equal(first.getAttribute('aria-busy'), 'true');
  assert.ok(first.children.some((c) => c.classList.contains('chat-tab-spin')));
  t.push(nav({ tabs: [tab(1, { active: true, loaded: true })] }));
  assert.equal(t.tabs()[0].getAttribute('aria-busy'), null);
  assert.equal(t.tabs()[0].textContent, 'chat 1', 'same label before and after loading');
});

test('clicking a verified conversation asks main to select it for the workspace shown, without confirmation', async () => {
  const t = mount();
  await t.tick();
  await t.click(t.tabs()[1]);
  assert.deepEqual(t.calls.select, [{ bindingId: tab(2).bindingId, workspaceKey: 'contextdeck/w1', confirm: false }]);
});

test('a conversation of an unverified workspace needs two clicks; Escape disarms; the confirm flag only goes with the second click', async () => {
  const s = nav({ tabs: [tab(1, { status: 'suspect', needsConfirm: true }), tab(2)] });
  const t = mount(s);
  await t.tick();
  await t.click(t.tabs()[0]);
  assert.equal(t.calls.select.length, 0, 'the first click only arms it');
  assert.equal(t.tabs()[0].textContent, 'Confirmar "chat 1"?');
  await t.document.fire('keydown', { key: 'Escape' });
  assert.equal(t.tabs()[0].textContent, 'chat 1');
  await t.click(t.tabs()[0]);
  await t.click(t.tabs()[0]);
  assert.deepEqual(t.calls.select, [{ bindingId: tab(1).bindingId, workspaceKey: 'contextdeck/w1', confirm: true }]);
  assert.deepEqual(t.calls.errors, []);
});

test('temporary conversations are chips: selecting one asks main; a warning marks pages that left their conversation', async () => {
  const t = mount(nav({ temporaries: [{ viewId: 'v7', label: 'Conversa não vinculada', relation: 'diverged', active: false, loading: false, failed: false, warning: true, bound: false }] }));
  await t.tick();
  const chip = t.tabs()[3];
  assert.equal(chip.textContent, 'Conversa não vinculada');
  assert.ok(chip.classList.contains('is-warn'));
  assert.match(chip.title, /outra conversa/);
  await t.click(chip);
  assert.deepEqual(t.calls.temp, [{ viewId: 'v7', workspaceKey: 'contextdeck/w1' }]);
});

test('"+" starts a new conversation under the workspace shown; without a workspace it opens the unscoped page', async () => {
  const t = mount();
  await t.tick();
  await t.click(t.get('chatbar-new'));
  assert.deepEqual(t.calls.create, [{ workspaceKey: 'contextdeck/w1' }]);
  assert.equal(t.get('chatbar-new').disabled, false);
  t.push(nav({ workspace: { ...nav().workspace, pending: true } }));
  assert.equal(t.get('chatbar-new').disabled, true, 'not while a workspace switch is in flight');
  t.push(nav({ workspace: null, tabs: [], empty: 'no-workspace' }));
  assert.equal(t.get('chatbar-ws').textContent, 'ChatGPT · sem workspace');
  await t.click(t.get('chatbar-new'));
  assert.equal(t.calls.unscoped, 1);
  assert.equal(t.calls.create.length, 1);
});

test('"Gerenciar" and the empty-state link open the I3A panel anchored on the button that was used', async () => {
  const t = mount(nav({ tabs: [], empty: 'no-conversations' }));
  await t.tick();
  await t.click(t.get('chatbar-manage'));
  await t.click(t.get('chat-empty-manage'));
  assert.deepEqual(t.calls.panel, ['chatbar-manage', 'chat-empty-manage']);
});

test('empty states: shown instead of any chat, with the reason; hidden as soon as a view is shown', async () => {
  const t = mount(nav({ tabs: [], empty: 'no-conversations' }));
  await t.tick();
  assert.equal(t.get('chat-empty').hidden, false);
  assert.equal(t.get('chat-empty-title').textContent, 'Este workspace ainda não tem conversas');
  assert.equal(t.get('chat-empty-new').textContent, 'Nova conversa');
  assert.equal(t.get('chatbar-tabs').children.find((c) => c.classList.contains('chatbar-none')).textContent, 'Sem conversas vinculadas');
  await t.click(t.get('chat-empty-new'));
  assert.equal(t.calls.create.length, 1);
  t.push(nav({ workspace: null, tabs: [], empty: 'no-workspace' }));
  assert.equal(t.get('chat-empty-title').textContent, 'Nenhum workspace selecionado');
  assert.equal(t.get('chat-empty-new').textContent, 'Abrir ChatGPT');
  assert.equal(t.get('chat-empty-manage').hidden, true);
  t.push(nav({ empty: 'not-verified', tabs: [tab(1, { status: 'suspect', needsConfirm: true })] }));
  assert.match(t.get('chat-empty-text').textContent, /confirme/);
  t.push(nav());
  assert.equal(t.get('chat-empty').hidden, true);
});

test('keyboard: arrows, Home and End move between the conversations (roving tabindex); activation is the native button behaviour', async () => {
  const t = mount();
  await t.tick();
  const [a, b, c] = t.tabs();
  a.focus();
  await t.get('chatbar-tabs').fire('keydown', { key: 'ArrowRight' });
  assert.equal(t.document.activeElement, b);
  assert.deepEqual(t.tabs().map((x) => x.tabIndex), [-1, 0, -1]);
  await t.get('chatbar-tabs').fire('keydown', { key: 'End' });
  assert.equal(t.document.activeElement, c);
  await t.get('chatbar-tabs').fire('keydown', { key: 'ArrowRight' });
  assert.equal(t.document.activeElement, c, 'does not wrap');
  await t.get('chatbar-tabs').fire('keydown', { key: 'Home' });
  assert.equal(t.document.activeElement, a);
  const ignored = await t.get('chatbar-tabs').fire('keydown', { key: 'x' });
  assert.equal(ignored.defaultPrevented, undefined);
  assert.equal(a.type, 'button', 'real buttons: Enter and Space work natively');
});

test('a refusal from main is shown in the status line, except the normal "needs confirmation" answer', async () => {
  const t = mount();
  await t.tick();
  t.setResults({ select: { ok: false, error: { code: 'context_changed', message: 'O workspace selecionado mudou. Revise a escolha.' } } });
  await t.click(t.tabs()[1]);
  assert.deepEqual(t.calls.errors, ['O workspace selecionado mudou. Revise a escolha.']);
  t.setResults({ select: { ok: false, error: { code: 'confirmation_required', message: 'x' } } });
  await t.click(t.tabs()[1]);
  assert.equal(t.calls.errors.length, 1);
});

test('labels are rendered as text, never as markup; the focused tab keeps focus across pushes', async () => {
  const t = mount(nav({ tabs: [tab(1, { label: '<img src=x onerror=alert(1)>', active: true }), tab(2)] }));
  await t.tick();
  assert.ok(t.get('chatbar-tabs')._all().every((n) => n.tag !== 'img'));
  assert.equal(t.tabs()[0].textContent, '<img src=x onerror=alert(1)>');
  t.tabs()[1].focus();
  t.push(nav({ tabs: [tab(1, { active: true }), tab(2, { loading: true })] }));
  assert.equal(t.document.activeElement.dataset.key, tab(2).bindingId);
});

test('dispose removes the subscription', async () => {
  const t = mount();
  await t.tick();
  t.handle.dispose();
  assert.equal(t.off(), true);
});

test('markup and layout: the strip and the empty state exist, are chat-only, and main lays the chat view out below top bar + strip', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8');
  assert.match(html, /<nav id="chatbar" class="chatbar chat-only" aria-label="Conversas do workspace">/);
  assert.match(html, /id="chatbar-tabs" class="chatbar-tabs" role="tablist"/);
  assert.match(html, /<section id="chat-empty" class="chat-empty chat-only"[^>]*hidden>/);
  const header = html.slice(html.indexOf('<header class="topbar">'), html.indexOf('</header>'));
  assert.match(header, /id="tab-terminal"/, 'the Terminal/ChatGPT switch is untouched');
  const tokens = fs.readFileSync(path.join(SRC, 'styles', 'tokens.css'), 'utf8');
  const px = Number(/--chatbar-h:\s*(\d+)px/.exec(tokens)[1]);
  const top = Number(/--topbar-h:\s*(\d+)px/.exec(tokens)[1]);
  const { TOPBAR_HEIGHT, CHATBAR_HEIGHT } = require('../src/main/window-metrics');
  assert.deepEqual([TOPBAR_HEIGHT, CHATBAR_HEIGHT], [top, px], 'main and the stylesheet agree on the chat view offset');
});

// ---- activity indicators (M01-I3B-2) ----------------------------------------------------------------------------------------

const { statusItems } = require('../src/shared/chat-nav-view');
const act = (over = {}) => ({ phase: 'ready', responding: false, ended: false, draft: false, attention: false, unknown: false, stale: false, evidence: 'observed', ...over });

test('status items: responding, attention, draft and unknown, in a fixed order; unknown is hidden while responding; no activity means nothing', () => {
  assert.deepEqual(statusItems(null), []);
  assert.deepEqual(statusItems(act()), [], 'loaded, observed, quiet: no indicator');
  assert.deepEqual(statusItems(act({ responding: true, attention: true, draft: true })).map((s) => s.kind), ['responding', 'attention', 'draft']);
  assert.deepEqual(statusItems(act({ unknown: true })).map((s) => s.kind), ['unknown']);
  assert.deepEqual(statusItems(act({ unknown: true, responding: true })).map((s) => s.kind), ['responding']);
  const all = statusItems(act({ responding: true, attention: true, draft: true, unknown: true }));
  assert.ok(all.every((s) => s.label && s.title && s.glyph), 'every indicator has a text label, a description and a shape');
  assert.equal(new Set(all.map((s) => s.glyph)).size, all.length, 'distinct shapes: not only colors');
  assert.match(statusItems(act({ attention: true }))[0].title, /não indica que terminou com sucesso/, 'attention never claims success');
  assert.doesNotMatch(JSON.stringify(all), /conclu[ií]d|completed/i, 'no indicator says "finished"');
});

test('tabs render a fixed slot with the indicators, an accessible name and a descriptive tooltip', async () => {
  const s = nav({ tabs: [tab(1, { active: true, activity: act({ responding: true, draft: true }) }), tab(2, { activity: act({ attention: true }) }), tab(3)] });
  const t = mount(s);
  await t.tick();
  const slots = t.tabs().map((x) => x.children.find((c) => c.classList.contains('chat-tab-status')));
  assert.ok(slots.every(Boolean), 'every tab has the slot, indicators or not');
  assert.deepEqual(slots.map((x) => x.children.map((c) => c.className.replace('status-ico ', ''))), [['is-responding', 'is-draft'], ['is-attention'], []]);
  assert.ok(slots.every((x) => x.getAttribute('aria-hidden') === 'true'), 'the slot is decorative: the name carries the meaning');
  assert.equal(t.tabs()[0].getAttribute('aria-label'), 'chat 1, Respondendo, Rascunho não enviado');
  assert.equal(t.tabs()[1].getAttribute('aria-label'), 'chat 2, Atividade para revisar');
  assert.equal(t.tabs()[2].getAttribute('aria-label'), null, 'no status: the visible text is the name');
  assert.match(t.tabs()[0].title, /está respondendo/);
  assert.match(t.tabs()[1].title, /abra para revisar/);
});

test('status changes never change the structure of a tab (same children, same order), so widths cannot jump', async () => {
  const t = mount(nav({ tabs: [tab(1, { active: true }), tab(2)] }));
  await t.tick();
  const shape = () => t.tabs().map((x) => x.children.map((c) => (c.classList.contains('chat-tab-text') ? 'text' : (c.classList.contains('chat-tab-status') ? 'slot' : 'other'))).join(','));
  const before = shape();
  t.push(nav({ tabs: [tab(1, { active: true, activity: act({ responding: true, attention: true, draft: true }) }), tab(2, { activity: act({ unknown: true }) })] }));
  assert.deepEqual(shape(), before);
  t.push(nav({ tabs: [tab(1, { active: true }), tab(2)] }));
  assert.deepEqual(shape(), before);
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  assert.match(css, /\.chat-tab-status\s*\{[^}]*min-width:/, 'the slot reserves its width in CSS');
});

test('indicators do not get in the way: tabs stay clickable and focusable, and the focused tab keeps focus when its status changes', async () => {
  const t = mount(nav({ tabs: [tab(1, { active: true }), tab(2)] }));
  await t.tick();
  t.tabs()[1].focus();
  t.push(nav({ tabs: [tab(1, { active: true, activity: act({ attention: true }) }), tab(2, { activity: act({ responding: true }) })] }));
  assert.equal(t.document.activeElement.dataset.key, tab(2).bindingId);
  await t.click(t.tabs()[1]);
  assert.deepEqual(t.calls.select.map((c) => c.bindingId), [tab(2).bindingId]);
  assert.ok(t.tabs().every((x) => x.tabIndex === 0 || x.tabIndex === -1));
});

test('temporary conversations show their status too, and nothing is shown for views that are not observed', async () => {
  const t = mount(nav({ temporaries: [{ viewId: 'v7', label: 'Nova conversa', relation: 'temporary', active: false, loading: false, failed: false, warning: false, bound: false, activity: act({ draft: true }) }], tabs: [tab(1, { activity: null }), tab(2, { activity: null })] }));
  await t.tick();
  const slots = t.tabs().map((x) => x.children.find((c) => c.classList.contains('chat-tab-status')).children.length);
  assert.deepEqual(slots, [0, 0, 1]);
  assert.equal(t.tabs()[2].getAttribute('aria-label'), 'Nova conversa, Rascunho não enviado');
});

test('motion: the only animation is the existing spinner keyframes and base.css turns animations off for reduced motion', () => {
  const css = fs.readFileSync(path.join(SRC, 'styles', 'components.css'), 'utf8');
  const base = fs.readFileSync(path.join(SRC, 'styles', 'base.css'), 'utf8');
  assert.equal([...css.matchAll(/@keyframes/g)].length, 1);
  assert.match(css, /\.status-ico\.is-responding[^}]*animation: spin var\(--duration-spin\)/);
  assert.match(base, /prefers-reduced-motion: reduce[\s\S]*animation/);
  assert.doesNotMatch(css.slice(css.indexOf('Indicators inside a tab'), css.indexOf('Footer: Git bar')), /#[0-9a-fA-F]{3,8}\b|rgba?\(/);
});
