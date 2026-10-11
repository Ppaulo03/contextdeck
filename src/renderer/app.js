// Renderer entry: creates the components and wires them to the preload bridge (`window.dock`).
// Each component owns its DOM and state; this file only connects them.
import '@xterm/xterm/css/xterm.css';
import { $ } from './components/dom.js';
import { createFeedback } from './components/feedback.js';
import { createHerdrStore } from './components/herdr-store.js';
import { createTerminalView } from './components/terminal-view.js';
import { initHeader } from './components/header.js';
import { initGitPanel } from './components/git-panel.js';
import { initHerdrPanel } from './components/herdr-panel.js';
import { initWorkspaceSelector } from './components/workspace-selector.js';

const dock = window.dock;
const feedback = createFeedback();
const store = createHerdrStore(dock);
const terminal = createTerminalView({ dock, root: $('terminal-root'), feedback });
const header = initHeader({ dock, onReconnect: () => void terminal.start() });
const herdrPanel = initHerdrPanel({ dock, store });
initWorkspaceSelector({ dock, store, feedback });
initGitPanel({ dock, feedback });

dock.onMode((mode) => {
  header.setMode(mode);
  if (mode === 'chat') herdrPanel.hide();
  else terminal.show();
});
dock.onChatStatus((message) => { if (header.getMode() === 'chat') feedback.notice(message); });
dock.onChatHost((hostname) => { if (header.getMode() === 'chat') feedback.notice(`Navegando: ${hostname}`); });
dock.onChatError((message) => feedback.error(`ChatGPT: ${message}`));

async function init() {
  const info = await dock.info();
  if (info) header.setSession(info.sessionName);
  await terminal.start();
}

void init();
