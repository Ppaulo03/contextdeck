'use strict';

const { parseChatUrl } = require('../chat/conversation-identity');
const { initialRuntime, observation, PageLifecycle, Reliability, Source } = require('../chat/runtime-contract');

// ChatViewManager (M01-I3B-1): owns the ChatGPT views and nothing else. Plain Node: Electron is reached only
// through the two injected collaborators, so everything here is unit-tested with mocks.
//
//   createView({ id, url, onEvent }) -> handle   builds one view on the persistent ChatGPT session (chat-view.js).
//        handle: { getUrl(), loadURL(url) -> Promise, focus(), isDestroyed(), destroy() }
//        It reports through onEvent(kind, payload): 'navigation-started' | 'navigated' {url} | 'loaded' |
//        'load-failed' {error} | 'process-gone' | 'destroyed'.
//   host { attach(handle), detach(handle), setBounds(handle) }   how a view appears in / disappears from the window.
//
// What a view IS (entry):
//   scope        workspace key ("session/workspaceId") the view is shown under, or null (unscoped, M00-style page)
//   expectedKey  conversationKey the view was opened for (the binding that owns it), or null (temporary view)
//   identity     what the page ACTUALLY shows now, from its URL only: { state: 'durable'|'pending'|'other'|'unknown', key }
//   epoch        bumps whenever the identity changes; stale observations are never attributed across epochs
//   page         loading | ready | error | destroyed          (PageLifecycle, from navigation events only)
// The relation between expectation and identity is derived, never stored (relation()). A view that stops showing
// its conversation is NOT mutated by an event: it keeps its expectation until someone explicitly takes it over
// (open()/demote()), so a transient redirect cannot detach a view, and a real divergence cannot go unnoticed.
//
// Lifecycle rules (docs/decisions/0003-multi-view.md): views are created only on demand; an existing view is
// never reloaded or navigated to select it; hiding a view only detaches it; nothing is destroyed except by
// destroyAll() when the application closes. No pool, no eviction.

// See setIdentity().
const REDIRECT_WINDOW_MS = 3000;

const REL = Object.freeze({ MATCH: 'match', LOADING: 'loading', DIVERGED: 'diverged', LEFT: 'left', TEMPORARY: 'temporary', ACQUIRED: 'acquired' });

// match      shows the conversation it was opened for
// loading    still going there (identity not known yet)
// diverged   shows a DIFFERENT durable conversation (the user navigated inside ChatGPT)
// left       shows a page without a durable id (e.g. "new chat") while it was opened for a conversation
// temporary  opened for no conversation and still without a durable id
// acquired   a temporary view that received a durable id (it is not bound to anything until the user binds it)
function relation(entry) {
  const id = entry.identity;
  if (entry.expectedKey) {
    if (id.state === 'durable') return id.key === entry.expectedKey ? REL.MATCH : REL.DIVERGED;
    if (id.state === 'unknown') return REL.LOADING;
    return REL.LEFT;
  }
  return id.state === 'durable' ? REL.ACQUIRED : REL.TEMPORARY;
}

const identityOf = (url) => {
  if (!url) return { state: 'unknown', key: null, url: '' };
  const parsed = parseChatUrl(url);
  if (parsed.ok) return { state: 'durable', key: parsed.conversationKey, url: parsed.url };
  if (parsed.reason === 'identity-pending') return { state: 'pending', key: null, url: '' };
  return { state: 'other', key: null, url: '' };
};

function createChatViewManager({ createView, host, now = () => Date.now() }) {
  const entries = new Map();
  const listeners = new Set();
  let seq = 0;
  let visibleId = null;      // the view that should be on screen when the chat tab is shown
  let attached = false;      // is the chat tab showing right now?
  let attachedId = null;     // the handle currently attached to the window (at most one)
  let destroyed = false;

  const emit = () => { for (const l of [...listeners]) l(); };
  const alive = (e) => Boolean(e) && e.page !== 'destroyed' && !e.handle.isDestroyed();

  function setPage(entry, page) {
    entry.page = page;
    entry.runtime = { ...entry.runtime, page: observation(page, { source: Source.NAVIGATION, reliability: Reliability.OBSERVED, observedAt: now() }) };
  }

  function setIdentity(entry, url) {
    const next = identityOf(url);
    if (next.state === entry.identity.state && next.key === entry.identity.key) { entry.identity = next; return false; }
    // Observed with a logged-out profile and for unavailable conversations: ChatGPT commits /c/<id>, finishes
    // loading, and its SPA redirects to "/" a few hundred ms later. A page that leaves its conversation within
    // REDIRECT_WINDOW_MS of having finished loading on it never really showed it (this is a guard against spawning a
    // replacement view for every click on such a conversation, not a debounce of any decision).
    if (entry.reached && entry.expectedKey && next.key !== entry.expectedKey && now() - entry.reachedAt < REDIRECT_WINDOW_MS) entry.reached = false;
    entry.identity = next;
    entry.epoch += 1;
    return true;
  }

  // Every event of a view lands here. Events of a destroyed or unknown view are dropped.
  function onEvent(id, kind, payload = {}) {
    const entry = entries.get(id);
    if (!entry || entry.page === 'destroyed') return;
    let changed = false;
    switch (kind) {
      case 'navigation-started': setPage(entry, PageLifecycle.LOADING); changed = true; break;
      case 'navigated': changed = setIdentity(entry, payload.url) || changed; break;
      case 'loaded':
        // A load that finished after the view was told to load something newer says nothing about it.
        if (payload.loadSeq !== undefined && payload.loadSeq !== entry.loadSeq) return;
        if (entry.page !== 'ready') { setPage(entry, PageLifecycle.READY); changed = true; }
        // The page finished loading ON its conversation: it really showed it. (An address that commits and then
        // redirects away while loading - unavailable or deleted conversation - never gets here.)
        if (entry.expectedKey && entry.identity.state === 'durable' && entry.identity.key === entry.expectedKey && !entry.reached) { entry.reached = true; entry.reachedAt = now(); changed = true; }
        break;
      case 'load-failed': setPage(entry, PageLifecycle.ERROR); changed = true; break;
      case 'process-gone': setPage(entry, PageLifecycle.ERROR); changed = true; break;
      case 'destroyed': setPage(entry, PageLifecycle.DESTROYED); if (attachedId === id) { attachedId = null; } if (visibleId === id) visibleId = null; changed = true; break;
      default: return;
    }
    if (changed) emit();
  }

  function register(handle, { scope, expectedKey, id, pristine }) {
    const entry = {
      id, handle, scope, expectedKey, pristine,
      identity: identityOf(handle.getUrl ? handle.getUrl() : ''),
      epoch: 0, reached: false, reachedAt: 0, page: PageLifecycle.LOADING, loadSeq: 0, createdAt: now(), lastShownAt: 0,
      runtime: initialRuntime()
    };
    entries.set(id, entry);
    return entry;
  }

  // Creates a view on demand and starts loading `url` once. `pristine` marks the application's initial,
  // never-shown ChatGPT page (the M00 view): it may be handed to the first "new conversation" without any
  // navigation, and is never navigated to anything else.
  function create({ url, scope = null, expectedKey = null, pristine = false }) {
    if (destroyed) return null;
    const id = `v${++seq}`;
    const handle = createView({ id, url, onEvent: (kind, payload) => onEvent(id, kind, payload) });
    const entry = register(handle, { scope, expectedKey, id, pristine });
    load(entry, url);
    emit();
    return id;
  }

  function load(entry, url) {
    entry.loadSeq += 1;
    const mine = entry.loadSeq;
    setPage(entry, PageLifecycle.LOADING);
    Promise.resolve(entry.handle.loadURL(url)).then(
      () => onEvent(entry.id, 'loaded', { loadSeq: mine }),
      (error) => {
        // A navigation superseded by another one (ERR_ABORTED, -3) is not a failure of the view.
        if (entry.loadSeq === mine && !(error && (error.errno === -3 || error.code === 'ERR_ABORTED'))) onEvent(entry.id, 'load-failed', { error });
      }
    );
  }

  // Explicit retry of a view whose load failed (there is nothing to preserve in it).
  function reloadFailed(id, url) {
    const entry = entries.get(id);
    if (!alive(entry) || entry.page !== PageLifecycle.ERROR) return false;
    load(entry, url);
    emit();
    return true;
  }

  const reconcileAttachment = () => {
    const wanted = attached && visibleId && alive(entries.get(visibleId)) ? visibleId : null;
    if (attachedId && attachedId !== wanted) {
      const old = entries.get(attachedId);
      if (old && alive(old)) host.detach(old.handle);
      attachedId = null;
    }
    if (wanted && attachedId !== wanted) {
      const entry = entries.get(wanted);
      host.attach(entry.handle);
      attachedId = wanted;
    }
    if (attachedId) host.setBounds(entries.get(attachedId).handle);
  };

  function show(id) {
    const entry = entries.get(id);
    if (!alive(entry)) return false;
    visibleId = id;
    entry.lastShownAt = now();
    entry.pristine = false;
    reconcileAttachment();
    emit();
    return true;
  }

  function hide() {
    if (visibleId === null) return;
    visibleId = null;
    reconcileAttachment();
    emit();
  }

  // The chat tab appears / disappears. The logical visible view is kept, so coming back shows the same one.
  function setAttached(value) {
    attached = Boolean(value);
    reconcileAttachment();
  }

  const relayout = () => { if (attachedId) host.setBounds(entries.get(attachedId).handle); };

  function setScope(id, scope) { const e = entries.get(id); if (e && e.scope !== scope) { e.scope = scope; emit(); } }
  function setExpected(id, key) {
    const e = entries.get(id);
    if (!e || e.expectedKey === key) return;
    e.expectedKey = key;
    e.reached = Boolean(key) && e.identity.state === 'durable' && e.identity.key === key;
    emit();
  }

  // The view that currently SHOWS conversation `key` (identity truth), preferring the one opened for it.
  function findByKey(key) {
    const shown = [...entries.values()].filter((e) => alive(e) && e.identity.state === 'durable' && e.identity.key === key);
    return shown.find((e) => e.expectedKey === key) || shown.sort((a, b) => b.lastShownAt - a.lastShownAt)[0] || null;
  }
  // The view opened for `key` that has not (yet) navigated anywhere else.
  const findLoadingFor = (key) => [...entries.values()].find((e) => alive(e) && e.expectedKey === key && relation(e) === REL.LOADING) || null;
  // The view opened for `key` that has NEVER shown it (the address redirected away: unavailable or deleted
  // conversation, or a redirect still settling). It is that conversation's view; opening the tab again must not
  // spawn another one every time. A view that did show it and then left (the user navigated away) is not this.
  const findNeverReached = (key) => [...entries.values()].find((e) => alive(e) && e.expectedKey === key && !e.reached && (relation(e) === REL.LEFT || relation(e) === REL.LOADING)) || null;

  // Views that show the same durable conversation: a state the UI must be able to report. The manager never
  // destroys either of them.
  function duplicates() {
    const byKey = new Map();
    for (const e of entries.values()) {
      if (!alive(e) || e.identity.state !== 'durable') continue;
      byKey.set(e.identity.key, [...(byKey.get(e.identity.key) || []), e.id]);
    }
    return [...byKey.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, viewIds: ids }));
  }

  function snapshot(entry) {
    return {
      id: entry.id, scope: entry.scope, expectedKey: entry.expectedKey, identity: { ...entry.identity }, epoch: entry.epoch,
      page: entry.page, relation: relation(entry), visible: entry.id === visibleId, attached: entry.id === attachedId,
      pristine: entry.pristine, reached: entry.reached, lastShownAt: entry.lastShownAt
    };
  }

  // Runtime context of a view (M01-I3B-1 keeps it minimal: lifecycle, identity and epoch are live; generation,
  // draft and attention stay `unknown` until I3B-2 wires the observer to each view).
  function runtimeOf(id) {
    const e = entries.get(id);
    return e ? Object.freeze({ viewId: e.id, epoch: e.epoch, identity: { state: e.identity.state, key: e.identity.key }, expectedKey: e.expectedKey, ...e.runtime }) : null;
  }

  function destroyAll() {
    destroyed = true;
    attached = false;
    visibleId = null;
    reconcileAttachment();
    for (const e of entries.values()) {
      if (e.page !== 'destroyed') { try { e.handle.destroy(); } catch { /* Already gone. */ } setPage(e, PageLifecycle.DESTROYED); }
    }
    entries.clear();
    listeners.clear();
  }

  return {
    create, reloadFailed, show, hide, setAttached, relayout, setScope, setExpected,
    findByKey, findLoadingFor, findNeverReached, duplicates, runtimeOf, destroyAll,
    get: (id) => (entries.has(id) ? snapshot(entries.get(id)) : null),
    list: () => [...entries.values()].filter(alive).map(snapshot),
    handleOf: (id) => (entries.has(id) ? entries.get(id).handle : null),
    getVisibleId: () => visibleId,
    getAttachedId: () => attachedId,
    isAttached: () => attached,
    isVisible: (id) => id === visibleId && attached,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    _size: () => entries.size
  };
}

module.exports = { createChatViewManager, relation, identityOf, REL };
