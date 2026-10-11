import '@xterm/xterm/css/xterm.css';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { initGitPanel } from './git-panel.js';
import { initHerdrPanel } from './herdr-panel.js';
import { initWorkspaceSelector } from './workspace-selector.js';

const dock = window.dock;
const app = document.getElementById('app');
const terminalRoot = document.getElementById('terminal-root');
const notice = document.getElementById('notification');
const terminalTab = document.getElementById('tab-terminal');
const chatTab = document.getElementById('tab-chat');

const terminal = new Terminal({
  cursorBlink: true,
  fontFamily: 'Cascadia Code, Consolas, monospace',
  fontSize: 14,
  lineHeight: 1.1,
  scrollback: 3000,
  allowTransparency: false,
  theme: {
    background: '#0b0f16', foreground: '#dce5f5', cursor: '#b6c6e5', selectionBackground: '#456793',
    black: '#0b0f16', red: '#f7768e', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c0caf5'
  }
});
const fitAddon = new FitAddon();
terminal.loadAddon(fitAddon);
terminal.open(terminalRoot);

let terminalRunning = false;

function setNotice(message) {
  notice.textContent = String(message);
}

function showError(message) {
  setNotice(message);
  terminal.write(`\r\n\x1b[31m[ContextDeck] ${message}\x1b[0m\r\n`);
}

function resizeTerminal() {
  try {
    fitAddon.fit();
    if (terminalRunning) dock.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
  } catch { /* Dimension can temporarily be zero while window initializes. */ }
}

async function startTerminal() {
  terminalRunning = false;
  resizeTerminal();
  terminal.write('\r\n\x1b[36m[ContextDeck]\x1b[0m Iniciando Herdr...\r\n');
  try {
    const result = await dock.startTerminal({ cols: terminal.cols, rows: terminal.rows });
    if (!result?.ok) {
      showError(result?.error || 'Falha ao iniciar o Herdr');
    } else {
      terminalRunning = true;
      setNotice('Herdr conectado. Ctrl+Tab alterna para ChatGPT.');
      terminal.focus();
    }
  } catch (error) { showError(error?.message || String(error)); }
}

function setMode(mode) {
  if (mode !== 'terminal' && mode !== 'chat') return;
  app.dataset.mode = mode;
  if (mode === 'chat') herdrPanel.hide();
  terminalTab.classList.toggle('active', mode === 'terminal');
  terminalTab.setAttribute('aria-selected', String(mode === 'terminal'));
  chatTab.classList.toggle('active', mode === 'chat');
  chatTab.setAttribute('aria-selected', String(mode === 'chat'));
  if (mode === 'terminal') {
    window.requestAnimationFrame(() => {
      resizeTerminal();
      terminal.focus();
    });
  }
}

async function copySelection() {
  const selection = terminal.getSelection();
  if (!selection) return setNotice('Selecione texto no terminal antes de copiar.');
  try {
    await dock.copyText(selection);
    setNotice(`Selecao copiada (${selection.length} caracteres).`);
  } catch (error) { setNotice(`Falha no clipboard: ${error?.message || error}`); }
}

async function pasteToTerminal() {
  try {
    const text = await dock.readText();
    if (typeof text !== 'string' || !text) return setNotice('Clipboard vazio.');
    terminal.paste(text);
    terminal.focus();
    setNotice('Texto colado. Quebras de linha podem ser interpretadas pelo agente.');
  } catch (error) { setNotice(`Falha ao colar: ${error?.message || error}`); }
}

terminal.onData((data) => dock.writeTerminal(data));
terminal.onResize(({ cols, rows }) => {
  if (terminalRunning) dock.resizeTerminal({ cols, rows });
});
terminal.attachCustomKeyEventHandler((event) => {
  if (event.type !== 'keydown') return true;
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') {
    void copySelection();
    return false;
  }
  if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') {
    void pasteToTerminal();
    return false;
  }
  return true;
});

const observer = new ResizeObserver(resizeTerminal);
observer.observe(terminalRoot);
dock.onMode(setMode);
dock.onFocusTerminal(() => window.requestAnimationFrame(() => terminal.focus()));
dock.onPtyData((data) => terminal.write(data));
dock.onPtyExit(({ exitCode }) => {
  terminalRunning = false;
  terminal.write(`\r\n\x1b[33m[ContextDeck] Herdr client encerrado (codigo ${exitCode}). A sessao no servidor pode continuar ativa.\x1b[0m\r\n`);
  setNotice('Herdr encerrou. Clique em Reconectar Herdr.');
});
dock.onChatStatus((message) => { if (app.dataset.mode === 'chat') setNotice(message); });
dock.onChatHost((hostname) => { if (app.dataset.mode === 'chat') setNotice(`Navegando: ${hostname}`); });
dock.onChatError((message) => { setNotice(`ChatGPT: ${message}`); });

terminalTab.addEventListener('click', () => void dock.switchTo('terminal'));
chatTab.addEventListener('click', () => void dock.switchTo('chat'));
document.getElementById('reconnect-terminal').addEventListener('click', () => void startTerminal());
document.getElementById('chat-home').addEventListener('click', () => void dock.chatHome());
document.getElementById('reload-chat').addEventListener('click', () => void dock.reloadChat());
document.getElementById('external-chat').addEventListener('click', () => void dock.openExternalChat());

initGitPanel({ dock, setNotice });
const herdrPanel = initHerdrPanel({ dock });
initWorkspaceSelector({ dock, setNotice });

async function init() {
  const info = await dock.info();
  if (info) document.getElementById('session-name').textContent = `Herdr: ${info.sessionName}`;
  resizeTerminal();
  await startTerminal();
}

void init();
