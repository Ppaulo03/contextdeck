// Application header: the Terminal/ChatGPT switch and the controls that belong to each view.
// Chat controls talk to the main process through the preload bridge; terminal controls are callbacks.
import { $, setAttr } from './dom.js';

export function initHeader({ dock, onReconnect }) {
  const app = $('app');
  const tabs = { terminal: $('tab-terminal'), chat: $('tab-chat') };

  function setMode(mode) {
    if (mode !== 'terminal' && mode !== 'chat') return;
    app.dataset.mode = mode;
    for (const [name, tab] of Object.entries(tabs)) {
      setAttr(tab, 'aria-selected', name === mode);
    }
  }

  tabs.terminal.addEventListener('click', () => void dock.switchTo('terminal'));
  tabs.chat.addEventListener('click', () => void dock.switchTo('chat'));
  $('reconnect-terminal').addEventListener('click', onReconnect);
  $('chat-home').addEventListener('click', () => void dock.chatHome());
  $('reload-chat').addEventListener('click', () => void dock.reloadChat());
  $('external-chat').addEventListener('click', () => void dock.openExternalChat());

  return {
    setMode,
    getMode: () => app.dataset.mode
  };
}
