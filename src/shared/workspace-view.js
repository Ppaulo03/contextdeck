'use strict';

// Pure view-model for the workspace selector, shared by the top bar trigger and the menu overlay.
// No DOM and no Electron here, so it is unit-tested directly in Node.
//
// Principles (M01-I2.5):
//   * the trigger keeps the last known workspace label while an operation is pending (no "..." swap);
//   * what the user requested, what Herdr reports and what is confirmed stay distinguishable in the
//     tooltip and in the menu, but the bar itself stays calm (no certainty claims, no alarm wording);
//   * labels always carry the id so workspaces with the same name are told apart.

const optionLabel = (o) => `${o.id} · ${o.label || '(sem nome)'}`;

const ORIGIN_TEXT = { dock: 'escolhido no ContextDeck', herdr: 'acompanhando o foco do Herdr', recovery: 'recuperado' };

function findOption(selection, id) {
  return (selection && selection.options ? selection.options : []).find((o) => o.id === id) || null;
}

// `shown` is what the trigger displayed last ({ id, text }), kept by the caller between renders.
function triggerModel(state, shown) {
  const sel = state && state.selection;
  if (!sel) return { text: 'Herdr desconectado', tone: 'placeholder', busy: false, disabled: true, shown: null, title: 'Sem dados do Herdr ainda.', mode: 'auto', modeDisabled: true };

  const connected = sel.connection === 'connected';
  const pending = Boolean(sel.pending);
  const selectedId = sel.selected ? sel.selected.workspaceId : null;
  const option = findOption(sel, selectedId);

  // While a switch is pending the previous label is kept: only the spinner and the tooltip change.
  let next = shown || null;
  let tone = 'normal';
  if (!pending) {
    if (selectedId) next = { id: selectedId, text: option ? optionLabel(option) : selectedId };
    else if (sel.unavailableId) { next = { id: sel.unavailableId, text: `${sel.unavailableId} · indisponível` }; tone = 'warning'; }
    else next = null;
  }

  let text;
  if (next) text = next.text;
  else if (!connected) text = sel.connection === 'connecting' ? 'Conectando ao Herdr…' : 'Herdr desconectado';
  else text = 'Selecione um workspace';
  if (!next) tone = 'placeholder';
  else if (!connected && tone === 'normal') tone = 'dim';

  const parts = [];
  if (pending) parts.push(`Trocando para ${optionLabelFor(sel, sel.pending.workspaceId)}…`);
  if (!connected) parts.push(sel.connection === 'connecting' ? 'Reconectando ao Herdr.' : 'Herdr desconectado: a lista mostra o último estado conhecido.');
  if (sel.observedId) parts.push(`Foco atual do Herdr: ${sel.observedId}.`);
  if (sel.selected) parts.push(`Origem: ${ORIGIN_TEXT[sel.selected.origin] || sel.selected.origin}.`);
  if (sel.lastError) parts.push(`Último erro: ${sel.lastError.message}`);

  return {
    text,
    tone,
    busy: pending,
    // Exposed as aria-disabled (not the `disabled` attribute) so keyboard focus is never lost mid-switch.
    disabled: !connected || pending,
    shown: next,
    title: parts.join(' '),
    mode: sel.mode,
    modeDisabled: false
  };
}

function optionLabelFor(sel, id) {
  const o = findOption(sel, id);
  return o ? optionLabel(o) : id;
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Items of the menu, optionally filtered by a free-text query (matches id and name, accent-insensitive).
// Returns { items: [{ id, label, name, selected, observed }], emptyText }.
function menuModel(state, query = '') {
  const sel = state && state.selection;
  const options = sel ? sel.options : [];
  const q = fold(query).trim();
  const selectedId = sel && sel.selected ? sel.selected.workspaceId : null;
  const items = options
    .filter((o) => !q || fold(optionLabel(o)).includes(q))
    .map((o) => ({
      id: o.id,
      label: optionLabel(o),
      name: o.label || '(sem nome)',
      detail: o.directory || '',
      selected: o.id === selectedId,
      observed: Boolean(sel && sel.observedId === o.id)
    }));
  let emptyText = '';
  if (!items.length) emptyText = options.length ? 'Nenhum workspace corresponde à busca.' : (sel && sel.connection !== 'connected' ? 'Herdr desconectado.' : 'Nenhum workspace na sessão.');
  return { items, emptyText, connected: Boolean(sel && sel.connection === 'connected'), unavailableId: sel ? sel.unavailableId : null };
}

module.exports = { optionLabel, triggerModel, menuModel, fold, ORIGIN_TEXT };
