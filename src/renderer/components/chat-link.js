// Top-bar indicator of the current ChatGPT conversation: bound to the selected workspace, to another one,
// not bound, or identity not known yet. It only displays; clicking opens the bindings panel (an overlay, so it
// works above the ChatGPT view). It never changes the page, the selection or Herdr.
import { $, setAttr, setText } from './dom.js';
import { indicatorModel } from '../../shared/chat-bindings-view.js';

export function initChatLink({ dock, feedback }) {
  const button = $('chat-link');
  let state = null;

  function render(next) {
    state = next || state;
    const model = indicatorModel(state);
    setText(button, model.text);
    if (button.title !== model.title) button.title = model.title;
    button.classList.toggle('is-success', model.tone === 'success');
    button.classList.toggle('is-neutral', model.tone === 'neutral');
  }

  async function openPanel() {
    const box = button.getBoundingClientRect();
    const result = await dock.openChatsPanel({ x: box.left, y: box.top, width: box.width, height: box.height });
    if (result && result.ok) setAttr(button, 'aria-expanded', true);
    else feedback.error('Não foi possível abrir o painel de conversas.');
  }

  button.addEventListener('click', () => void openPanel());
  // The overlay closes by itself (Esc, click outside, resize, tab switch): put focus back on the trigger.
  const offClosed = dock.onOverlayClosed((kind) => { if (kind === 'chats' && button.getAttribute('aria-expanded') === 'true') { setAttr(button, 'aria-expanded', false); button.focus(); } });
  const offState = dock.onChatsState(render);
  void dock.chatsState().then((initial) => { if (!state && initial) render(initial); });
  render(null);

  return { dispose() { offClosed(); offState(); } };
}
