// Workspace selector in the top bar: a combobox-style trigger plus the Auto/Manual toggle. It renders
// the view-model computed from the state pushed by the main process and reports the user's choices.
//
// The list itself is a menu overlay (a separate local view above the ChatGPT view), so it opens over
// both tabs. This component never decides anything about Herdr and never sends workspace.focus: the
// overlay does, only from the user's explicit choice, through the validated selection channel.
import { $, setAttr, setText } from './dom.js';
import { triggerModel } from '../../shared/workspace-view.js';

export function initWorkspaceSelector({ dock, store, feedback }) {
  const trigger = $('ws-trigger');
  const label = $('ws-trigger-text');
  const modeButton = $('ws-mode');
  let shown = null;        // what the trigger displayed last: kept while a switch is pending
  let model = triggerModel(null, null);

  function render(state) {
    model = triggerModel(state, shown);
    shown = model.shown;
    setText(label, model.text);
    label.classList.toggle('is-placeholder', model.tone === 'placeholder');
    label.classList.toggle('is-dim', model.tone === 'dim');
    label.classList.toggle('is-warning', model.tone === 'warning');
    setAttr(trigger, 'aria-busy', model.busy);
    setAttr(trigger, 'aria-disabled', model.disabled);
    if (trigger.title !== model.title) trigger.title = model.title;
    const auto = model.mode === 'auto';
    setText(modeButton, auto ? 'Auto' : 'Manual');
    setAttr(modeButton, 'aria-pressed', auto);
    modeButton.disabled = model.modeDisabled;
    modeButton.title = auto
      ? 'Automático: acompanha o último foco do Herdr (estimativa: com mais de um cliente conectado pode divergir). Clique para alternar para manual.'
      : 'Manual: mudanças de foco no Herdr não alteram esta escolha. Clique para acompanhar o foco do Herdr.';
  }

  async function openMenu() {
    if (model.disabled) return;
    const box = trigger.getBoundingClientRect();
    const result = await dock.openWorkspaceMenu({ x: box.left, y: box.top, width: box.width, height: box.height });
    if (result && result.ok) setAttr(trigger, 'aria-expanded', true);
    else feedback.error('Não foi possível abrir o menu de workspaces.');
  }

  trigger.addEventListener('click', () => void openMenu());
  trigger.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); void openMenu(); }
  });
  modeButton.addEventListener('click', async () => {
    const state = store.get();
    if (!state || !state.selection) return;
    const result = await dock.herdrSetSyncMode({ mode: state.selection.mode === 'auto' ? 'manual' : 'auto' });
    if (!result || !result.ok) feedback.error('Não foi possível alterar o modo de sincronização.');
  });

  // The menu closes by itself on Esc, click outside, resize or tab switch: put focus back on the trigger.
  const offClosed = dock.onOverlayClosed(() => { setAttr(trigger, 'aria-expanded', false); trigger.focus(); });
  const offStore = store.subscribe(render);
  render(store.get());

  return { dispose() { offClosed(); offStore(); } };
}
