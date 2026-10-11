'use strict';

// In-app activity notices (M01-I3B-2H): a short list of "activity to review" events for the overlay to show as discreet
// cards. Plain Node. It decides WHAT is listed and for how long; it never clears attention (that is a visit, see
// chat-views/observation.js), never opens anything and never reads a page. Notices are ephemeral: closing or expiring one
// leaves the pending state untouched, and nothing here is persisted.
//
// Policy: one notice per view (a repeat refreshes it instead of stacking), newest first, at most `maxVisible` shown
// (the rest are counted as "more"), each expires after `ttlMs`, one shared timer, and a notice goes away by itself when the
// attention it announced is acknowledged.
function createNoticeController({ setTimer = setTimeout, clearTimer = clearTimeout, now = () => Date.now(), ttlMs = 8000, maxVisible = 3, maxStored = 20 } = {}) {
  let items = [];
  let timer;
  const listeners = new Set();
  const emit = () => { const s = getState(); for (const l of [...listeners]) l(s); };

  function schedule() {
    clearTimer(timer);
    timer = undefined;
    if (!items.length) return;
    const next = Math.min(...items.map((i) => i.at + ttlMs));
    timer = setTimer(() => { timer = undefined; expire(); }, Math.max(1, next - now()));
    timer.unref?.();
  }

  function expire() {
    const before = items.length;
    items = items.filter((i) => now() < i.at + ttlMs);
    schedule();
    if (items.length !== before) emit();
  }

  function getState() {
    const shown = items.slice(0, maxVisible);
    return {
      items: shown.map(({ id, viewId, workspaceId, workspaceLabel, label, bindingId, kind, openable }) => ({ id, viewId, workspaceId, workspaceLabel, label, bindingId, kind, openable })),
      more: Math.max(0, items.length - shown.length)
    };
  }

  return {
    push(event) {
      if (!event || typeof event.viewId !== 'string') return;
      const id = `n:${event.viewId}`;
      items = items.filter((i) => i.id !== id);
      items.unshift({ id, at: now(), viewId: event.viewId, workspaceId: event.workspaceId || null, workspaceLabel: event.workspaceLabel || '', label: event.label || '', bindingId: event.bindingId || null, kind: event.kind || 'temporary', openable: Boolean(event.openable) });
      if (items.length > maxStored) items.length = maxStored;
      schedule();
      emit();
    },
    dismiss(id) { const before = items.length; items = items.filter((i) => i.id !== id); schedule(); if (items.length !== before) emit(); },
    // The attention behind a notice was acknowledged (or the view is gone): the notice has no reason to stay.
    clearView(viewId) { const before = items.length; items = items.filter((i) => i.viewId !== viewId); schedule(); if (items.length !== before) emit(); },
    // Keeps only the notices whose attention is still pending (the user visited the conversation meanwhile).
    retain(predicate) { const before = items.length; items = items.filter((i) => predicate(i)); schedule(); if (items.length !== before) emit(); },
    getState,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    stop() { clearTimer(timer); timer = undefined; items = []; listeners.clear(); }
  };
}

module.exports = { createNoticeController };
