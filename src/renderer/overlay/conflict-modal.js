// Conflict modal (M01-I3B-3): the page on screen shows a conversation that belongs to ANOTHER workspace. It is a real modal: a
// scrim over the whole window, no close button, Esc and clicks outside do nothing, Tab stays between its buttons. The only way
// out is one of the three decisions; main closes it when the conflict is gone (and re-opens it if something closes it earlier).
// Everything shown comes from main (`banner`, built by shared/chat-nav-view.js); text is always set with textContent.
import { $, el } from '../components/dom.js';

export function createConflictModal({ api }) {
  const panel = $('conflict');
  const textNode = $('conflict-text');
  const actions = $('conflict-actions');
  const message = $('conflict-message');
  const title = $('conflict-title');
  const TITLES = { conflict: 'Conversa de outro workspace', offer: 'Vincular Project?', confirm: 'Conversa fora do Project', pending: 'Conversa ainda não vinculada' };
  let banner = null;
  let armedTransfer = false;
  let busy = false;

  const buttons = () => Array.from(actions.children).filter((n) => n.tag === 'button' || n.tagName === 'BUTTON');

  function say(text) { message.textContent = text || ''; message.hidden = !text; }

  function render() {
    textNode.textContent = banner ? banner.text : '';
    title.textContent = banner ? (TITLES[banner.kind] || TITLES.conflict) : '';
    actions.textContent = '';
    if (!banner) return;
    for (const a of banner.actions) {
      const armed = a.action === 'transfer' && armedTransfer;
      const b = el('button', `btn${armed ? ' is-armed' : ''}`, armed ? 'Confirmar transferência' : a.label);
      b.type = 'button';
      b.title = a.title;
      b.disabled = busy;
      b.dataset.key = `conflict:${a.action}`;
      b.addEventListener('click', () => void decide(a));
      actions.append(b);
    }
  }

  async function decide(a) {
    if (busy || !banner) return;
    if (a.action === 'transfer' && !armedTransfer) { armedTransfer = true; render(); focusKey('conflict:transfer'); return; }   // the first click arms it
    armedTransfer = false;
    busy = true;
    say('Aguarde…');
    render();
    let result;
    try { result = await api.conflictResolve({ viewId: banner.viewId, action: a.action }); } catch (error) { result = { ok: false, error: { message: (error && error.message) || 'Falha inesperada.' } }; }
    busy = false;
    say(result && result.ok ? '' : ((result && result.error && result.error.message) || 'Não foi possível concluir. Escolha de novo.'));
    render();
  }

  function focusKey(key) { const b = buttons().find((x) => x.dataset.key === key); if (b) b.focus(); }

  return {
    open(next) {
      banner = next && next.banner ? next.banner : null;
      armedTransfer = false; busy = false;
      say('');
      panel.hidden = false;
      render();
      const first = buttons()[0];
      if (first) first.focus();
    },
    // A new picture of the same (or another) conflict while the modal is open.
    push(next) {
      const sameView = banner && next && next.banner && next.banner.viewId === banner.viewId;
      banner = next && next.banner ? next.banner : null;
      if (!sameView) armedTransfer = false;
      render();
    },
    hide() { panel.hidden = true; banner = null; armedTransfer = false; },
    // Nothing closes it: Esc is swallowed; Tab / Shift+Tab cycle inside; arrows move between the buttons.
    handleKey(event) {
      const list = buttons().filter((b) => !b.disabled);
      const index = list.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        // A conflict cannot be dismissed. The other questions have a negative answer, and Esc is it.
        const no = banner && banner.kind !== 'conflict' ? banner.actions.find((a) => a.action === 'skip') : null;
        if (no) void decide(no);
        return true;
      }
      if (event.key === 'Tab' || event.key === 'ArrowRight' || event.key === 'ArrowDown' || event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (!list.length) return true;
        const back = (event.key === 'Tab' && event.shiftKey) || event.key === 'ArrowLeft' || event.key === 'ArrowUp';
        list[(Math.max(index, 0) + (back ? list.length - 1 : 1)) % list.length].focus();
        return true;
      }
      return false;
    }
  };
}
