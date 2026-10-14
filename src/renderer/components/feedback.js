// Status line in the footer: one place for discreet feedback, with an error level.
import { $, setAttr, setText } from './dom.js';

export function createFeedback(element = $('status')) {
  function notice(message, level = 'info') {
    setText(element, String(message));
    setAttr(element, 'data-level', level);
  }
  return { notice, error: (message) => notice(message, 'error') };
}
