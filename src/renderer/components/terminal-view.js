// Herdr terminal: xterm.js on top of the PTY bridge. The theme is read from the design tokens.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';

export function createTerminalView({ dock, root, feedback }) {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();

  const terminal = new Terminal({
    cursorBlink: true,
    fontFamily: token('--font-mono'),
    fontSize: 14,
    lineHeight: 1.1,
    scrollback: 3000,
    allowTransparency: false,
    theme: {
      background: token('--term-bg'), foreground: token('--term-fg'), cursor: token('--term-cursor'), selectionBackground: token('--term-selection'),
      black: token('--term-bg'), red: token('--danger'), green: token('--success'), yellow: token('--warning'),
      blue: token('--term-blue'), magenta: token('--violet'), cyan: token('--info'), white: token('--term-white')
    }
  });
  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(root);

  let running = false;
  let fitScheduled = false;

  // Fits to the container once per frame, however many resize notifications arrive. The PTY is told
  // only when the grid really changed (xterm's onResize), never from the fit itself.
  function scheduleFit() {
    if (fitScheduled) return;
    fitScheduled = true;
    window.requestAnimationFrame(() => {
      fitScheduled = false;
      try { fitAddon.fit(); } catch { /* Dimensions can be zero while the window initializes. */ }
    });
  }

  function showError(message) {
    feedback.error(message);
    terminal.write(`\r\n\x1b[31m[ContextDeck] ${message}\x1b[0m\r\n`);
  }

  async function start() {
    running = false;
    try { fitAddon.fit(); } catch { /* See scheduleFit. */ }
    terminal.write('\r\n\x1b[36m[ContextDeck]\x1b[0m Iniciando Herdr...\r\n');
    const size = { cols: terminal.cols, rows: terminal.rows };
    try {
      const result = await dock.startTerminal(size);
      if (!result?.ok) return showError(result?.error || 'Falha ao iniciar o Herdr');
      running = true;
      if (terminal.cols !== size.cols || terminal.rows !== size.rows) dock.resizeTerminal({ cols: terminal.cols, rows: terminal.rows });
      feedback.notice('Herdr conectado. Ctrl+Tab alterna para ChatGPT.');
      terminal.focus();
    } catch (error) { showError(error?.message || String(error)); }
  }

  async function copySelection() {
    const selection = terminal.getSelection();
    if (!selection) return feedback.notice('Selecione texto no terminal antes de copiar.');
    try {
      await dock.copyText(selection);
      feedback.notice(`Selecao copiada (${selection.length} caracteres).`);
    } catch (error) { feedback.error(`Falha no clipboard: ${error?.message || error}`); }
  }

  async function pasteToTerminal() {
    try {
      const text = await dock.readText();
      if (typeof text !== 'string' || !text) return feedback.notice('Clipboard vazio.');
      terminal.paste(text);
      terminal.focus();
      feedback.notice('Texto colado. Quebras de linha podem ser interpretadas pelo agente.');
    } catch (error) { feedback.error(`Falha ao colar: ${error?.message || error}`); }
  }

  terminal.onData((data) => dock.writeTerminal(data));
  terminal.onResize(({ cols, rows }) => { if (running) dock.resizeTerminal({ cols, rows }); });
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyC') { void copySelection(); return false; }
    if (event.ctrlKey && event.shiftKey && event.code === 'KeyV') { void pasteToTerminal(); return false; }
    return true;
  });

  const observer = new ResizeObserver(scheduleFit);
  observer.observe(root);
  const offs = [
    dock.onFocusTerminal(() => window.requestAnimationFrame(() => terminal.focus())),
    dock.onPtyData((data) => terminal.write(data)),
    dock.onPtyExit(({ exitCode }) => {
      running = false;
      terminal.write(`\r\n\x1b[33m[ContextDeck] Herdr client encerrado (codigo ${exitCode}). A sessao no servidor pode continuar ativa.\x1b[0m\r\n`);
      feedback.notice('Herdr encerrou. Clique em Reconectar Herdr.');
    })
  ];

  return {
    start,
    // Called when the terminal becomes the visible view again.
    show() { scheduleFit(); window.requestAnimationFrame(() => terminal.focus()); },
    focus: () => terminal.focus(),
    dispose() { observer.disconnect(); for (const off of offs) off(); terminal.dispose(); }
  };
}
