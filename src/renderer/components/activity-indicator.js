// Global activity indicator in the top bar (M01-I3B-2H): visible on the Terminal and the ChatGPT tab, whatever workspace is
// selected. It shows how many conversations (of every workspace, loaded and observed) are responding / have activity to review
// / have an unsent draft, and opens the activity center. It only renders `activity:state`: it observes nothing, loads
// nothing and changes nothing. Fixed minimum size (set in CSS) so updates never shift the bar.
import { $, el, setAttr, setText } from './dom.js';
import { indicatorModel } from '../../shared/activity-view.js';

export function initActivityIndicator({ dock, feedback }) {
  const button = $('activity-indicator');
  const slot = $('activity-text');
  let state = null;
  let shown = '';

  function render(next) {
    state = next || state;
    const model = indicatorModel(state);
    const key = `${model.text}|${model.idle}|${model.attention}`;
    if (key !== shown) {
      shown = key;
      slot.textContent = '';
      if (model.idle) slot.append(el('span', 'act-ico is-idle', '○'));
      for (const part of model.parts) {
        const unit = el('span', `act-part is-${part.kind}`);
        unit.append(el('span', `act-ico${part.kind === 'responding' ? ' is-spin' : ''}`, part.glyph), el('span', 'act-count', String(part.count)));
        slot.append(unit);
      }
      if (model.idle) slot.append(el('span', 'act-label', 'Atividade'));
    }
    if (button.title !== model.title) button.title = model.title;
    setAttr(button, 'aria-label', model.aria);
    button.classList.toggle('is-idle', model.idle);
    button.classList.toggle('has-attention', Boolean(model.attention));
  }

  async function openCenter() {
    const box = button.getBoundingClientRect();
    const result = await dock.openActivityCenter({ x: box.left, y: box.top, width: box.width, height: box.height });
    if (result && result.ok) setAttr(button, 'aria-expanded', true);
    else feedback.error('Não foi possível abrir a central de atividade.');
  }

  button.addEventListener('click', () => void openCenter());
  const offClosed = dock.onOverlayClosed((kind) => {
    if (kind === 'activity' && button.getAttribute('aria-expanded') === 'true') { setAttr(button, 'aria-expanded', false); button.focus(); }
  });
  const offState = dock.onActivityState(render);
  void dock.activityState().then((initial) => { if (!state && initial) render(initial); });
  render(null);

  return { dispose() { offClosed(); offState(); } };
}
