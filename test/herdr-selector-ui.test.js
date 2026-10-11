'use strict';

// Drives src/renderer/workspace-selector.js against a minimal fake DOM. The module is an ES module
// bundled by esbuild, so it is evaluated here with its `export` stripped.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this._value = ''; this.hidden = false; this.disabled = false; this.title = ''; this._text = ''; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(v) { this._text = v; if (v === '') this.children = []; }
  get textContent() { return this._text; }
  // Like a real <select>: assigning a value does NOT fire "change"; unknown values normalize to ''.
  set value(v) { this._value = this.tag === 'select' ? (this.children.some((c) => c.value === v) ? v : '') : v; }
  get value() { return this._value; }
  fire(type) { return Promise.all((this.listeners[type] || []).map((fn) => fn())); }
}

function load() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'workspace-selector.js'), 'utf8').replace('export function initWorkspaceSelector', 'function initWorkspaceSelector') + '\nreturn initWorkspaceSelector;';
  const elements = { 'ws-select': new El('select'), 'ws-mode': new El('button'), 'ws-busy': new El('span') };
  elements['ws-busy'].hidden = true;
  const document = { getElementById: (id) => elements[id], createElement: (tag) => { const e = new El(tag); return e; } };
  const init = new Function('document', source)(document);
  const dock = {
    selects: [], modes: [], pushState: null, initial: null,
    herdrSelectWorkspace: async (args) => { dock.selects.push(args); return dock.selectResult || { ok: true }; },
    herdrSetSyncMode: async (args) => { dock.modes.push(args); return { ok: true }; },
    onHerdrState: (cb) => { dock.pushState = cb; },
    herdrState: async () => dock.initial
  };
  const notices = [];
  init({ dock, setNotice: (m) => notices.push(m) });
  const optionTexts = () => elements['ws-select'].children.map((c) => `${c.value}|${c.textContent}`);
  return { el: elements, dock, notices, optionTexts };
}

const state = (over = {}) => ({
  session: 'contextdeck',
  selection: {
    mode: 'auto', connection: 'connected', canSelect: true, pending: null, unavailableId: null, observedId: 'w2',
    options: [{ id: 'w1', label: 'api' }, { id: 'w2', label: 'app' }, { id: 'w3', label: 'app' }],
    selected: { workspaceId: 'w2', origin: 'herdr' }, ...over
  }
});

test('initial state: disabled with a plain "disconnected" placeholder', () => {
  const ui = load();
  assert.equal(ui.el['ws-select'].disabled, true);
  assert.deepEqual(ui.optionTexts(), ['|Herdr desconectado']);
  assert.equal(ui.el['ws-mode'].disabled, true);
});

test('options show id and name so homonymous workspaces are distinguishable; the selection is applied', () => {
  const ui = load();
  ui.dock.pushState(state());
  assert.deepEqual(ui.optionTexts(), ['|Selecione um workspace', 'w1|w1 · api', 'w2|w2 · app', 'w3|w3 · app']);
  assert.equal(ui.el['ws-select'].value, 'w2');
  assert.equal(ui.el['ws-select'].disabled, false);
  assert.equal(ui.el['ws-mode'].textContent, 'Auto');
  assert.equal(ui.el['ws-mode'].attrs['aria-pressed'], 'true');
});

test('programmatic updates NEVER send workspace.focus (only a real user change does)', async () => {
  const ui = load();
  ui.dock.pushState(state());
  for (const id of ['w1', 'w3', 'w2', 'w1', null, 'w3']) {
    ui.dock.pushState(state({ selected: id ? { workspaceId: id, origin: 'herdr' } : null }));
    assert.equal(ui.el['ws-select'].value, id || '');
  }
  ui.dock.pushState(state({ options: [{ id: 'w1', label: 'renamed' }], selected: { workspaceId: 'w1', origin: 'herdr' } }));
  assert.deepEqual(ui.dock.selects, [], 'state-driven changes (selection, rename, removal) sent nothing');
  // A user choice does.
  ui.el['ws-select'].value = 'w1';
  await ui.el['ws-select'].fire('change');
  assert.deepEqual(ui.dock.selects, [{ session: 'contextdeck', workspaceId: 'w1' }]);
});

test('a change event while the UI is applying state, or with no value, is ignored', async () => {
  const ui = load();
  ui.dock.pushState(state());
  ui.el['ws-select'].value = '';
  await ui.el['ws-select'].fire('change');
  assert.deepEqual(ui.dock.selects, []);
});

test('failures are reported discreetly and the dropdown returns to the real state; stale results stay silent', async () => {
  const ui = load();
  ui.dock.pushState(state());
  ui.dock.selectResult = { ok: false, error: { code: 'workspace_not_found', message: 'Esse workspace nao existe mais na sessao.' } };
  ui.el['ws-select'].value = 'w3';
  await ui.el['ws-select'].fire('change');
  assert.deepEqual(ui.notices, ['Workspace: Esse workspace nao existe mais na sessao.']);
  assert.equal(ui.el['ws-select'].value, 'w2', 'dropdown restored to the actual selection');
  ui.dock.selectResult = { ok: false, stale: true, error: { code: 'stale', message: 'x' } };
  ui.el['ws-select'].value = 'w3';
  await ui.el['ws-select'].fire('change');
  assert.equal(ui.notices.length, 1, 'obsolete operations are not announced');
});

test('pending operation: selector disabled, busy indicator visible, aria-busy set', () => {
  const ui = load();
  ui.dock.pushState(state({ canSelect: false, pending: { workspaceId: 'w3', startedAt: 1 }, selected: { workspaceId: 'w3', origin: 'dock' } }));
  assert.equal(ui.el['ws-select'].disabled, true);
  assert.equal(ui.el['ws-busy'].hidden, false);
  assert.equal(ui.el['ws-select'].attrs['aria-busy'], 'true');
  ui.dock.pushState(state());
  assert.equal(ui.el['ws-busy'].hidden, true);
});

test('disconnected / connecting / unavailable placeholders', () => {
  const ui = load();
  ui.dock.pushState(state({ connection: 'disconnected', canSelect: false, options: [] , selected: null }));
  assert.deepEqual(ui.optionTexts(), ['|Herdr desconectado']);
  assert.equal(ui.el['ws-select'].disabled, true);
  ui.dock.pushState(state({ connection: 'connecting', canSelect: false, options: [], selected: null }));
  assert.deepEqual(ui.optionTexts(), ['|Conectando ao Herdr…']);
  ui.dock.pushState(state({ selected: null, unavailableId: 'w9' }));
  assert.match(ui.optionTexts()[0], /w9 indisponível/);
  assert.equal(ui.el['ws-select'].disabled, false, 'the user can pick another workspace');
});

test('mode button toggles the preference and explains that auto is an estimate, without alarming wording', async () => {
  const ui = load();
  ui.dock.pushState(state());
  assert.match(ui.el['ws-mode'].title, /estimativa/);
  await ui.el['ws-mode'].fire('click');
  assert.deepEqual(ui.dock.modes, [{ mode: 'manual' }]);
  ui.dock.pushState(state({ mode: 'manual' }));
  assert.equal(ui.el['ws-mode'].textContent, 'Manual');
  assert.equal(ui.el['ws-mode'].attrs['aria-pressed'], 'false');
  await ui.el['ws-mode'].fire('click');
  assert.deepEqual(ui.dock.modes, [{ mode: 'manual' }, { mode: 'auto' }]);
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'workspace-selector.js'), 'utf8');
  assert.doesNotMatch(source, /AMBIGU|ambiguous/i, 'uncertainty lives in the diagnostic panel, not in the main bar');
});

test('the dropdown is not rebuilt (which would close an open list) unless options actually changed', () => {
  const ui = load();
  ui.dock.pushState(state());
  const first = ui.el['ws-select'].children[1];
  ui.dock.pushState(state({ selected: { workspaceId: 'w3', origin: 'herdr' } }));
  assert.equal(ui.el['ws-select'].children[1], first, 'same option nodes after a selection-only update');
  ui.dock.pushState(state({ options: [{ id: 'w1', label: 'api' }, { id: 'w2', label: 'app' }, { id: 'w3', label: 'app' }, { id: 'w4', label: 'new' }] }));
  assert.equal(ui.el['ws-select'].children.length, 5);
});
