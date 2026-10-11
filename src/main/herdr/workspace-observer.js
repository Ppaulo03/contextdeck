'use strict';

const { createApiClient, SUBSCRIPTION_TYPES } = require('./api-client');
const { readWorkspaces, identifyActiveWorkspace } = require('./workspace-reader');

const DEFAULTS = Object.freeze({
  backoffInitialMs: 1000,
  backoffMaxMs: 15000,
  debounceMs: 300,          // coalesces bursts of events into one re-read
  minSyncIntervalMs: 1000,  // upper bound on event-driven re-reads
  heartbeatMs: 60000        // reconciles lost events; deliberately slow, never aggressive polling
});

function workspaceIdOf(data) {
  if (!data) return null;
  return data.workspace_id || (data.workspace && data.workspace.workspace_id) || null;
}

// Keeps a model of the workspaces of one Herdr session. Read-only.
//
// Strategy (Herdr events carry no sequence number, so they cannot be replayed or ordered):
//   1. subscribe first, so nothing that happens during the first read is missed;
//   2. read the authoritative snapshot;
//   3. treat every event only as a *signal* "something changed": coalesce and re-read;
//   4. re-read on a slow heartbeat and after every reconnect to repair lost events.
// Duplicated, delayed or out-of-order events are therefore harmless: the state always comes from the
// latest snapshot. There is at most one subscription, one read in flight and one retry timer.
function createWorkspaceObserver({
  session,
  locate,
  createApi = createApiClient,
  scheduler = { setTimeout, clearTimeout },
  now = () => Date.now(),
  options = {}
}) {
  const cfg = { ...DEFAULTS, ...options };
  const listeners = new Set();
  let generation = 0;       // invalidates callbacks of previous connections
  let stopped = true;
  let connecting = false;
  let api;
  let subscription;
  let retryTimer;
  let refreshTimer;
  let heartbeatTimer;
  let attempts = 0;
  let syncing = null;
  let rerun = null;
  let lastSyncStartedAt = 0;

  const state = {
    session,
    connection: 'stopped',
    lastError: null,
    attempts: 0,
    model: null,
    lastEvent: null,
    lastSync: null,
    syncCount: 0,
    eventCount: 0
  };

  const snapshotState = () => ({ ...state, active: identifyActiveWorkspace(state.model) });
  const emit = () => { const s = snapshotState(); for (const listener of [...listeners]) listener(s); };
  const setError = (error) => { state.lastError = error ? { code: error.code || 'error', message: error.message || String(error), at: now() } : null; };

  function clearTimers() {
    for (const timer of [retryTimer, refreshTimer, heartbeatTimer]) if (timer) scheduler.clearTimeout(timer);
    retryTimer = refreshTimer = heartbeatTimer = undefined;
  }

  function teardownConnection() {
    generation += 1;
    if (subscription) { try { subscription.close(); } catch { /* Already closed. */ } }
    if (api) { try { api.close(); } catch { /* Already closed. */ } }
    subscription = undefined;
    api = undefined;
    syncing = null;
    rerun = null;
    if (refreshTimer) { scheduler.clearTimeout(refreshTimer); refreshTimer = undefined; }
    if (heartbeatTimer) { scheduler.clearTimeout(heartbeatTimer); heartbeatTimer = undefined; }
  }

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    const delay = Math.min(cfg.backoffMaxMs, cfg.backoffInitialMs * 2 ** Math.min(attempts, 10));
    attempts += 1;
    state.attempts = attempts;
    retryTimer = scheduler.setTimeout(() => { retryTimer = undefined; void connect(); }, delay);
  }

  function handleDisconnect(error) {
    if (stopped) return;
    teardownConnection();
    connecting = false;
    state.connection = 'disconnected';
    setError(error);
    emit();
    scheduleRetry();
  }

  function scheduleHeartbeat() {
    if (stopped || heartbeatTimer) return;
    heartbeatTimer = scheduler.setTimeout(() => { heartbeatTimer = undefined; void sync('heartbeat'); }, cfg.heartbeatMs);
  }

  // Single-flight read: a request made while one is running is merged into one trailing re-read.
  function sync(reason) {
    if (stopped || !api) return Promise.resolve();
    if (syncing) { rerun = reason; return syncing; }
    const mine = generation;
    lastSyncStartedAt = now();
    syncing = readWorkspaces(api, { session, now })
      .then((model) => {
        if (mine !== generation) return;
        state.model = model;
        state.lastSync = { at: now(), reason };
        state.syncCount += 1;
        if (state.connection !== 'connected') { state.connection = 'connected'; setError(null); attempts = 0; state.attempts = 0; }
        emit();
      })
      .catch((error) => { if (mine === generation) handleDisconnect(error); })
      .finally(() => {
        if (mine !== generation) return;
        syncing = null;
        if (heartbeatTimer) { scheduler.clearTimeout(heartbeatTimer); heartbeatTimer = undefined; }
        if (state.connection === 'connected') scheduleHeartbeat();
        if (rerun) { const next = rerun; rerun = null; void sync(next); }
      });
    return syncing;
  }

  function scheduleRefresh() {
    if (stopped || refreshTimer || !api) return;
    const wait = Math.max(cfg.debounceMs, cfg.minSyncIntervalMs - (now() - lastSyncStartedAt));
    refreshTimer = scheduler.setTimeout(() => { refreshTimer = undefined; void sync('event'); }, wait);
  }

  async function connect() {
    if (stopped || connecting) return;
    connecting = true;
    state.connection = 'connecting';
    emit();
    const mine = ++generation;
    try {
      const endpoint = await locate(session);
      if (mine !== generation) return;
      if (!endpoint.running) throw Object.assign(new Error(`Herdr session "${session}" is not running`), { code: 'session_not_running' });
      const client = createApi({ socketPath: endpoint.socketPath });
      api = client;
      const handle = await client.subscribe(SUBSCRIPTION_TYPES, {
        onEvent: ({ event, data }) => {
          if (mine !== generation) return;
          state.eventCount += 1;
          state.lastEvent = { type: event, workspaceId: workspaceIdOf(data), at: now() };
          emit();
          scheduleRefresh();
        },
        onClose: (error) => { if (mine === generation) handleDisconnect(error || Object.assign(new Error('Herdr closed the event stream'), { code: 'stream_closed' })); }
      });
      if (mine !== generation) { handle.close(); return; }
      subscription = handle;
      connecting = false;
      await sync(state.syncCount > 0 ? 'reconnect' : 'initial');
    } catch (error) {
      if (mine === generation) handleDisconnect(error);
    } finally {
      if (mine === generation) connecting = false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      attempts = 0;
      state.attempts = 0;
      void connect();
    },
    stop() {
      stopped = true;
      connecting = false;
      clearTimers();
      teardownConnection();
      state.connection = 'stopped';
      emit();
      listeners.clear();
    },
    // Re-reads now when connected; otherwise retries the connection immediately.
    refresh() {
      if (stopped) return Promise.resolve();
      if (api && state.connection === 'connected') return sync('manual');
      if (retryTimer) { scheduler.clearTimeout(retryTimer); retryTimer = undefined; }
      return connect();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: snapshotState,
    // Test hook: how many resources are still held.
    _resources: () => ({ listeners: listeners.size, hasSubscription: Boolean(subscription), hasApi: Boolean(api), timers: [retryTimer, refreshTimer, heartbeatTimer].filter(Boolean).length })
  };
}

module.exports = { createWorkspaceObserver, DEFAULTS };
