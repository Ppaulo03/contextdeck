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
//   suspending   true only while explicit suspension awaits physical destruction; entry stays managed until confirmed
// The relation between expectation and identity is derived, never stored (relation()). A view that stops showing
// its conversation is NOT mutated by an event: it keeps its expectation until someone explicitly takes it over
// (open()/demote()), so a transient redirect cannot detach a view, and a real divergence cannot go unnoticed.
//
// Lifecycle rules (docs/decisions/0003-multi-view.md, 0005-view-lifecycle.md): views are created only on demand; an existing
// view is never reloaded or navigated to select it; hiding a view only detaches it; a view is destroyed in exactly two
// places: destroyAll() when the application closes, and suspend() on the user's explicit request (chat-views/lifecycle.js
// decides whether that is safe; this file keeps the entry managed until destruction is confirmed). No pool, no eviction, no timers.
//
// A suspended conversation has NO view. The manager keeps only a minimal in-memory record of it (`suspended`: conversation
// key -> recovery address), so the navigation can still list it and restoring it is the normal path (create()). The binding,
// not this record, stays the source of truth for what a conversation is; nothing here is persisted.

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

function createChatViewManager({ createView, host, now = () => Date.now(), destructionTimeoutMs = 5000 }) {
  const entries = new Map();
  const suspended = new Map();   // conversationKey -> { id, key, url, at }: conversations whose view was released on request
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
    if (page === PageLifecycle.READY && entry.firstReadyAt === null) entry.firstReadyAt = now();
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
      case 'navigated':
        changed = setIdentity(entry, payload.url) || changed;
        // Two pages without a conversation id (the home of a Project, then another Project's) have the same identity; the address
        // still changed and what the UI offers for it (link this Project) depends on it. No epoch bump: identity is unchanged.
        if (payload.url !== entry.lastUrl) { entry.lastUrl = payload.url; changed = true; }
        break;
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
      case 'destroyed':
        setPage(entry, PageLifecycle.DESTROYED);
        if (attachedId === id) { try { host.detach(entry.handle); } catch { /* The native view is already gone. */ } attachedId = null; }
        if (visibleId === id) visibleId = null;
        entries.delete(id);
        entry.destroyed?.();
        changed = true;
        break;
      default: return;
    }
    if (changed) emit();
  }

  function register(handle, { scope, expectedKey, id, pristine }) {
    const entry = {
      id, handle, scope, expectedKey, pristine,
      identity: identityOf(handle.getUrl ? handle.getUrl() : ''),
      epoch: 0, reached: false, reachedAt: 0, page: PageLifecycle.LOADING, loadSeq: 0, createdAt: now(), firstReadyAt: null, restoredFrom: null, lastShownAt: 0,
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
    // A view that comes back for a suspended conversation consumes its record: from here on the conversation HAS a view
    // (loading, which is the restoring state), so it can never be listed as suspended and loaded at once.
    const key = expectedKey || identityOf(url).key;
    if (key && suspended.has(key)) { entry.restoredFrom = suspended.get(key).at; suspended.delete(key); }
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
    if (!alive(entry) || entry.suspending) return false;
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

  // Releases the view of one conversation on explicit request. Structural checks only (the policy is lifecycle.js):
  // the view must be alive, not the one the user is looking at or that is attached, and show a durable conversation
  // whose canonical address is the recovery address. The entry leaves `entries` and listeners are told BEFORE the
  // page is destroyed, so observers stop before their WebContents goes away; late events of the old id are dropped.
  async function suspend(id, { url } = {}) {
    if (destroyed) return { ok: false, code: 'closed' };
    const entry = entries.get(id);
    if (!alive(entry)) return { ok: false, code: 'view_gone' };
    if (entry.suspending) return { ok: false, code: 'busy' };
    if (id === visibleId || id === attachedId) return { ok: false, code: 'selected' };
    if (entry.identity.state !== 'durable') return { ok: false, code: 'identity' };
    const target = identityOf(url);
    if (target.state !== 'durable' || target.key !== entry.identity.key) return { ok: false, code: 'recovery_url' };
    if (suspended.has(entry.identity.key)) return { ok: false, code: 'already_suspended' };
    const record = Object.freeze({ id, key: entry.identity.key, url: target.url, at: now() });
    entry.suspending = true;
    emit();
    let wake;
    const gone = new Promise((resolve) => { wake = resolve; });
    entry.destroyed = wake;
    let destroyError = null;
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(resolve, destructionTimeoutMs); });
    try {
      const result = entry.handle.destroy();
      if (result && typeof result.then === 'function') {
        await Promise.race([Promise.resolve(result).catch((error) => { destroyError = error; }), gone, timeout]);
      }
    } catch (error) { destroyError = error; }
    if (!entry.handle.isDestroyed() && entries.get(id) === entry && !destroyed) await Promise.race([gone, timeout]);
    clearTimeout(timer);
    const confirmed = entry.handle.isDestroyed() || entry.page === PageLifecycle.DESTROYED;
    entry.destroyed = null;
    if (confirmed) {
      entries.delete(id);
      if (!destroyed) suspended.set(record.key, record);
      emit();
      return destroyed ? { ok: false, code: 'closed' } : { ok: true, record };
    }
    entry.suspending = false;
    emit();
    return { ok: false, code: destroyed ? 'closed' : (destroyError ? 'destroy_failed' : 'destroy_timeout') };
  }

  function snapshot(entry) {
    return {
      id: entry.id, scope: entry.scope, expectedKey: entry.expectedKey, identity: { ...entry.identity }, epoch: entry.epoch,
      page: entry.page, relation: relation(entry), visible: entry.id === visibleId, attached: entry.id === attachedId,
      pristine: entry.pristine, reached: entry.reached, lastShownAt: entry.lastShownAt,
      createdAt: entry.createdAt, restored: entry.restoredFrom !== null,
      suspending: entry.suspending === true,
      restoreMs: entry.restoredFrom !== null && entry.firstReadyAt !== null ? entry.firstReadyAt - entry.createdAt : null
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
      e.destroyed?.();
    }
    entries.clear();
    suspended.clear();
    emit();                           // observers of the closed views stop on this signal
    listeners.clear();
  }

  return {
    create, suspend, reloadFailed, show, hide, setAttached, relayout, setScope, setExpected,
    findByKey, findLoadingFor, findNeverReached, duplicates, runtimeOf, destroyAll,
    get: (id) => (entries.has(id) ? snapshot(entries.get(id)) : null),
    list: () => [...entries.values()].filter(alive).map(snapshot),
    // History of one page (explicit user action only; selecting a view never navigates it).
    canGoBack: (id) => { const e = entries.get(id); return Boolean(alive(e) && e.handle.canGoBack && e.handle.canGoBack()); },
    goBack: (id) => { const e = entries.get(id); return Boolean(alive(e) && e.handle.goBack && e.handle.goBack()); },
    handleOf: (id) => (entries.has(id) ? entries.get(id).handle : null),
    unsentStateHintOf: (id) => {
      const e = entries.get(id);
      try { return e && e.handle.unsentStateHint ? e.handle.unsentStateHint() : 'unknown'; } catch { return 'unknown'; }
    },
    getVisibleId: () => visibleId,
    getAttachedId: () => attachedId,
    isAttached: () => attached,
    isClosed: () => destroyed,
    isSuspended: (key) => suspended.has(key),
    suspendedList: () => [...suspended.values()],
    dropSuspended: (key) => suspended.delete(key),
    isVisible: (id) => id === visibleId && attached,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    _size: () => entries.size
  };
}

module.exports = { createChatViewManager, relation, identityOf, REL };
