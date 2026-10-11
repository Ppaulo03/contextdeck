'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { optionLabel, triggerModel, menuModel, fold } = require('../src/shared/workspace-view');

const opts = [{ id: 'w1', label: 'api', directory: 'C:\\a' }, { id: 'w2', label: 'app', directory: 'C:\\b' }, { id: 'w3', label: 'app', directory: 'C:\\c' }];
const state = (sel = {}) => ({
  session: 's',
  selection: { mode: 'auto', connection: 'connected', canSelect: true, pending: null, unavailableId: null, observedId: 'w2', lastError: null, options: opts, selected: { workspaceId: 'w2', origin: 'herdr' }, ...sel }
});

test('labels always carry the id so equal names stay distinguishable; unnamed workspaces get a placeholder name', () => {
  assert.equal(optionLabel({ id: 'w2', label: 'app' }), 'w2 · app');
  assert.equal(optionLabel({ id: 'w3', label: '' }), 'w3 · (sem nome)');
  const m = menuModel(state());
  assert.deepEqual(m.items.map((i) => i.label), ['w1 · api', 'w2 · app', 'w3 · app']);
  assert.deepEqual(m.items.map((i) => i.selected), [false, true, false]);
  assert.deepEqual(m.items.map((i) => i.observed), [false, true, false]);
});

test('trigger shows the selected workspace; calm tone when connected', () => {
  const m = triggerModel(state(), null);
  assert.equal(m.text, 'w2 · app');
  assert.equal(m.tone, 'normal');
  assert.equal(m.busy, false);
  assert.equal(m.disabled, false);
  assert.equal(m.shown.id, 'w2');
  assert.equal(m.mode, 'auto');
  assert.match(m.title, /Foco atual do Herdr: w2/);
});

test('while a switch is pending the previous label is kept (no "..." swap); only busy/tooltip change', () => {
  const settled = triggerModel(state(), null);
  const pending = triggerModel(state({ pending: { workspaceId: 'w3', startedAt: 1 }, selected: { workspaceId: 'w3', origin: 'dock' } }), settled.shown);
  assert.equal(pending.text, 'w2 · app', 'label did not jump to the requested workspace');
  assert.equal(pending.busy, true);
  assert.equal(pending.disabled, true, 'a second switch cannot be started');
  assert.match(pending.title, /Trocando para w3 · app/);
  const done = triggerModel(state({ selected: { workspaceId: 'w3', origin: 'dock' }, observedId: 'w3' }), pending.shown);
  assert.equal(done.text, 'w3 · app');
  assert.equal(done.busy, false);
});

test('a failed switch returns to the previous label without passing through an intermediate text', () => {
  const texts = [];
  let shown = null;
  for (const s of [
    state(),
    state({ pending: { workspaceId: 'w3', startedAt: 1 }, selected: { workspaceId: 'w3', origin: 'dock' } }),
    state({ lastError: { code: 'x', message: 'Falha ao trocar' } })                      // reverted by the controller
  ]) { const m = triggerModel(s, shown); shown = m.shown; texts.push(m.text); }
  assert.deepEqual(texts, ['w2 · app', 'w2 · app', 'w2 · app']);
});

test('disconnected / reconnecting: the last known label stays (dimmed) instead of being replaced', () => {
  const shown = triggerModel(state(), null).shown;
  const down = triggerModel(state({ connection: 'disconnected', canSelect: false }), shown);
  assert.equal(down.text, 'w2 · app');
  assert.equal(down.tone, 'dim');
  assert.equal(down.disabled, true);
  assert.match(down.title, /Herdr desconectado/);
  const reconnecting = triggerModel(state({ connection: 'connecting', canSelect: false }), shown);
  assert.equal(reconnecting.text, 'w2 · app');
  assert.match(reconnecting.title, /Reconectando/);
});

test('placeholders only when there is nothing known to show', () => {
  assert.equal(triggerModel(null, null).text, 'Herdr desconectado');
  assert.equal(triggerModel(state({ connection: 'disconnected', selected: null, options: [] }), null).text, 'Herdr desconectado');
  assert.equal(triggerModel(state({ connection: 'connecting', selected: null, options: [] }), null).text, 'Conectando ao Herdr…');
  const none = triggerModel(state({ selected: null }), null);
  assert.equal(none.text, 'Selecione um workspace');
  assert.equal(none.tone, 'placeholder');
});

test('an unavailable workspace is announced with a warning tone and does not block choosing another', () => {
  const m = triggerModel(state({ selected: null, unavailableId: 'w9' }), null);
  assert.equal(m.text, 'w9 · indisponível');
  assert.equal(m.tone, 'warning');
  assert.equal(m.disabled, false);
  assert.equal(menuModel(state({ selected: null, unavailableId: 'w9' })).unavailableId, 'w9');
});

test('the main bar never uses alarming wording; errors appear only in the tooltip', () => {
  const m = triggerModel(state({ lastError: { code: 'timeout', message: 'Herdr nao respondeu' } }), null);
  assert.match(m.title, /Último erro: Herdr nao respondeu/);
  assert.doesNotMatch(m.text, /AMBIGU|erro|falha/i);
});

test('menu filtering is accent- and case-insensitive and matches id or name', () => {
  assert.equal(fold('Área Ação'), 'area acao');
  const s = state({ options: [{ id: 'w1', label: 'Relatório' }, { id: 'w2', label: 'api' }, { id: 'w10', label: 'x' }] });
  assert.deepEqual(menuModel(s, 'relatorio').items.map((i) => i.id), ['w1']);
  assert.deepEqual(menuModel(s, 'W1').items.map((i) => i.id), ['w1', 'w10']);
  assert.deepEqual(menuModel(s, '  API ').items.map((i) => i.id), ['w2']);
  const none = menuModel(s, 'zzz');
  assert.deepEqual(none.items, []);
  assert.match(none.emptyText, /Nenhum workspace corresponde/);
});

test('menu states: empty session and disconnected', () => {
  assert.match(menuModel(state({ options: [], selected: null })).emptyText, /Nenhum workspace na sessão/);
  const down = menuModel(state({ connection: 'disconnected', options: [], selected: null }));
  assert.equal(down.connected, false);
  assert.match(down.emptyText, /desconectado/);
  assert.deepEqual(menuModel(null).items, []);
});

// ---- conversation activity (M01-I3B-2) ---------------------------------------------------------------------------------

const { activityBadges } = require('../src/shared/workspace-view');

test('activity badges: counts of responding and pending conversations, singular/plural labels, nothing for zero or unknown workspaces', () => {
  assert.deepEqual(activityBadges(undefined), []);
  assert.deepEqual(activityBadges({ responding: 0, attention: 0, drafts: 1, loaded: 3, observed: 3 }), [], 'drafts and loaded counts are not badges; zero is not announced');
  const b = activityBadges({ responding: 2, attention: 1, loaded: 3, observed: 3 });
  assert.deepEqual(b.map((x) => [x.kind, x.count, x.glyph]), [['responding', 2, '↻'], ['attention', 1, '●']]);
  assert.equal(b[0].label, '2 conversas respondendo');
  assert.equal(b[1].label, '1 conversa com atividade para revisar');
  assert.equal(activityBadges({ responding: 1 })[0].label, '1 conversa respondendo');
});

test('menu items carry the badges of their workspace; a workspace that was never observed has none (not "idle")', () => {
  const s = { ...state(), activity: { w1: { responding: 1, attention: 0, drafts: 0, loaded: 1, observed: 1 }, w3: { responding: 0, attention: 2, drafts: 0, loaded: 2, observed: 2 } } };
  const items = menuModel(s).items;
  assert.deepEqual(items.map((i) => i.badges.map((b) => b.kind)), [['responding'], [], ['attention']]);
  assert.deepEqual(menuModel(state()).items.map((i) => i.badges), [[], [], []], 'no activity data: no badges');
});

test('the trigger summarises the other workspaces activity so it is visible with the menu closed; the selected workspace is not double counted', () => {
  const s = { ...state(), activity: { w1: { responding: 1, attention: 1 }, w2: { responding: 5, attention: 5 }, w3: { responding: 1, attention: 0 } } };
  const m = triggerModel(s, null);
  assert.equal(m.activity.text, '↻2 ●1');
  assert.match(m.activity.title, /outros workspaces/);
  assert.equal(triggerModel(state(), null).activity.text, '');
  assert.equal(triggerModel(null, null).activity.text, '');
  assert.equal(triggerModel({ ...state(), activity: { w2: { responding: 3, attention: 0 } } }, null).activity.text, '', 'only the selected workspace is active: nothing to add');
});
