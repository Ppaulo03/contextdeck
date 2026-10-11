'use strict';

// Development-only discovery tool (CONTEXTDECK_CHAT_TRACE=1, implies the diagnostic mode): while a person drives the real
// page, writes one row every ~700 ms describing what the page looks like around generation, so the signals can be chosen
// from evidence instead of guessed. Same rules as the probe: isolated world, read-only, NO text. Only UI chrome (control
// labels cut to 40 characters, test ids, attribute names, class tokens that look like state) and plain NUMBERS (how long
// the last answer is, how many turns exist) leave the page. Rows carry deltas of the test-id and class-token sets, so the
// moment something appears or disappears is visible.
const { FIND_COMPOSER, CANDIDATES, WORLD_ID } = require('./state-detector');

const STOPISH = '(stop|parar|interromp|cancel|encerr|paus|abort|interrupt)';
const TOKENS = '(stream|cursor|loading|generat|think|result-|typing|pulse|spinner|canvas|textdoc|artifact|writing|busy)';
const OTHER_EDITABLES = 'textarea, [contenteditable="true"], [role="textbox"], .ProseMirror, .cm-content';

const traceSource = () => `(() => {
  const C = ${JSON.stringify(CANDIDATES)};
  ${FIND_COMPOSER}
  const cut = (v, n = 40) => String(v == null ? '' : v).slice(0, n);
  const { composer, via } = findComposer();
  const form = composer && composer.closest ? composer.closest('form') : null;
  const attrs = (e) => [...e.attributes].filter((a) => !/^(class|style|id)$/.test(a.name)).map((a) => cut(a.name) + (/^(aria-|data-|type|role|disabled)/.test(a.name) ? '=' + cut(a.value, 24) : '')).sort().slice(0, 20);
  const btn = (b) => ({ tag: b.tagName, label: cut(b.getAttribute('aria-label')), testid: cut(b.getAttribute('data-testid')), vis: visible(b), attrs: attrs(b) });
  const stopRe = new RegExp(${JSON.stringify(STOPISH)}, 'i');
  const stopish = [];
  let n = 0;
  for (const b of document.querySelectorAll('button, [role="button"]')) {
    if (++n > 1500) break;
    const label = b.getAttribute('aria-label') || '';
    const testid = b.getAttribute('data-testid') || '';
    if (stopRe.test(label) || stopRe.test(testid)) stopish.push({ ...btn(b), inForm: !!(form && form.contains(b)) });
    if (stopish.length >= 8) break;
  }
  const busy = [...document.querySelectorAll('[aria-busy="true"], [data-streaming], [data-is-streaming]')].slice(0, 6).map((e) => ({ tag: e.tagName, role: cut(e.getAttribute('role')), testid: cut(e.getAttribute('data-testid')), vis: visible(e), inForm: !!(form && form.contains(e)) }));
  const assistants = [...document.querySelectorAll('[data-message-author-role="assistant"]')];
  const lastA = assistants[assistants.length - 1];
  const turns = [...document.querySelectorAll('[data-testid^="conversation-turn"]')];
  const lastTurn = turns[turns.length - 1];
  const editables = [...document.querySelectorAll(${JSON.stringify(OTHER_EDITABLES)})].filter((e) => e !== composer && visible(e));
  const testids = new Set(); const tokens = new Set(); let scanned = 0;
  const tokRe = new RegExp(${JSON.stringify(TOKENS)}, 'i');
  for (const e of document.querySelectorAll('*')) {
    if (++scanned > 6000) break;
    const t = e.getAttribute && e.getAttribute('data-testid'); if (t) testids.add(cut(t));
    const c = typeof e.className === 'string' ? e.className : '';
    if (c && tokRe.test(c)) for (const tok of c.split(/\\s+/)) if (tokRe.test(tok) && tokens.size < 80) tokens.add(cut(tok));
  }
  return {
    scanned, via, url: location.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, ':id').slice(0, 60),
    form: form ? attrs(form) : null,
    formButtons: form ? [...form.querySelectorAll('button')].slice(0, 12).map(btn) : [],
    submit: [...document.querySelectorAll(C.submit.join(','))].slice(0, 4).map(btn),
    stopish, busy, busyCount: document.querySelectorAll('[aria-busy="true"]').length,
    assistantCount: assistants.length, turnCount: turns.length,
    lastAnswerLen: lastA ? (lastA.textContent || '').length : null,
    lastTurnAttrs: lastTurn ? attrs(lastTurn) : null,
    otherEditables: editables.slice(0, 4).map((e) => ({ tag: e.tagName, len: (e.textContent || '').length, inForm: !!(form && form.contains(e)) })),
    iframes: document.querySelectorAll('iframe').length,
    active: document.activeElement ? document.activeElement.tagName : null,
    draftLen: composer ? String(composer.value !== undefined ? composer.value : composer.textContent || '').length : null,
    testids: [...testids].sort().slice(0, 400), tokens: [...tokens].sort()
  };
})()`;

const num = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1e8, Math.trunc(v))) : null);
const str = (v, n = 40) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');
const list = (v, limit, map) => (Array.isArray(v) ? v.slice(0, limit).map(map) : []);
const btn = (b) => ({ tag: str(b && b.tag, 12), label: str(b && b.label), testid: str(b && b.testid), vis: Boolean(b && b.vis === true), attrs: list(b && b.attrs, 20, (a) => str(a, 60)), ...(b && 'inForm' in b ? { inForm: b.inForm === true } : {}) });

// Rebuilds the page's answer from scratch (the page is untrusted); returns the row and the new test-id/token baselines.
function sanitizeTrace(raw, previous) {
  if (!raw || typeof raw !== 'object') return null;
  const ids = new Set(list(raw.testids, 400, (x) => str(x)));
  const tok = new Set(list(raw.tokens, 80, (x) => str(x)));
  const diff = (now, before) => ({ added: [...now].filter((x) => !before.has(x)).slice(0, 40), removed: [...before].filter((x) => !now.has(x)).slice(0, 40) });
  const row = {
    via: str(raw.via, 12) || null, url: str(raw.url, 60), scanned: num(raw.scanned),
    form: raw.form ? list(raw.form, 20, (a) => str(a, 60)) : null,
    formButtons: list(raw.formButtons, 12, btn), submit: list(raw.submit, 4, btn), stopish: list(raw.stopish, 8, btn),
    busy: list(raw.busy, 6, (b) => ({ tag: str(b && b.tag, 12), role: str(b && b.role), testid: str(b && b.testid), vis: Boolean(b && b.vis === true), inForm: Boolean(b && b.inForm === true) })),
    busyCount: num(raw.busyCount), assistantCount: num(raw.assistantCount), turnCount: num(raw.turnCount), lastAnswerLen: num(raw.lastAnswerLen),
    lastTurnAttrs: raw.lastTurnAttrs ? list(raw.lastTurnAttrs, 20, (a) => str(a, 60)) : null,
    otherEditables: list(raw.otherEditables, 4, (e) => ({ tag: str(e && e.tag, 12), len: num(e && e.len), inForm: Boolean(e && e.inForm === true) })),
    iframes: num(raw.iframes), active: str(raw.active, 12), draftLen: num(raw.draftLen),
    testids: previous ? diff(ids, previous.ids) : { added: [...ids].slice(0, 400), removed: [] },
    tokens: previous ? diff(tok, previous.tok) : { added: [...tok], removed: [] }
  };
  return { row, baseline: { ids, tok } };
}

// Starts the sampler for one view; returns stop().
function startTrace({ contents, log, intervalMs = 700, setRepeat = setInterval, clearRepeat = clearInterval, isVisible = () => null }) {
  let baseline = null;
  let busy = false;
  let last = null;
  const source = traceSource();
  const timer = setRepeat(async () => {
    if (busy || (contents.isDestroyed && contents.isDestroyed()) || (contents.isLoading && contents.isLoading())) return;
    busy = true;
    try {
      const raw = await contents.executeJavaScriptInIsolatedWorld(WORLD_ID, [{ code: source }]);
      const out = sanitizeTrace(raw, baseline);
      if (out) {
        baseline = out.baseline;
        const now = Date.now();
        log.note({ trace: out.row, dtMs: last === null ? null : now - last, visible: isVisible() });
        last = now;
      }
    } catch (error) { log.note({ traceError: String(error && error.message).slice(0, 80) }); } finally { busy = false; }
  }, intervalMs);
  if (timer && timer.unref) timer.unref();
  return () => clearRepeat(timer);
}

module.exports = { startTrace, traceSource, sanitizeTrace };
