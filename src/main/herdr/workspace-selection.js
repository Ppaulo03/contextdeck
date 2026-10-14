'use strict';

// Which workspace the ContextDeck selector shows, and how it moves (M01-I2).
//
// Model: ContextDeck is normally the only Herdr client of its session, so the session-wide focus
// reported by Herdr is *usually* the workspace shown by our client. Herdr's API cannot prove it
// (no per-client focus, see docs/validation/m01-i1.md), so following it is an optimistic estimate
// and is never presented as an identification of our client.
//
// State is kept separate on purpose:
//   selected    what the selector shows, with its origin: 'dock' (user picked it here), 'herdr'
//               (followed the observed focus) or 'recovery' (resolved after startup/reconnect);
//   pending     a focus request issued by the user that is not reconciled yet;
//   observedId  session focus in the latest authoritative snapshot (last writer, any client);
//   connection / reliability / lastError.
//
// Rules that keep this loop-free:
//   * The ONLY place that issues workspace.focus is select(), i.e. an explicit user action. Observing,
//     reconciling, reconnecting, switching mode or restoring preferences never sends a command.
//   * While a request is pending, observations are recorded but never overwrite `selected`.
//   * A request is bound to a token and to the connection epoch; if the connection was lost or another
//     request superseded it, its late completion is dropped and is never re-sent.
//   * Only explicit selections (origin 'dock') are persisted, never inferences.

const MODES = Object.freeze(['auto', 'manual']);

function createWorkspaceSelection({ session, observer, preferences, now = () => Date.now() }) {
  const listeners = new Set();
  const initial = preferences.get();
  const state = {
    session,
    mode: MODES.includes(initial.mode) ? initial.mode : 'auto',
    selected: null,
    unavailableId: null,
    pending: null,
    observedId: null,
    reliability: 'none',
    lastError: null
  };
  let off;
  let opToken = 0;
  let lastEpoch = -1;
  let lastSyncCount = -1;
  let recovering = true;     // the next resolution is a recovery (startup or after a reconnect)
  let restored = false;      // persisted selection already considered

  const emit = () => { const s = getState(); for (const l of [...listeners]) l(s); };
  const fail = (code, message) => ({ ok: false, error: { code, message } });
  const setError = (code, message) => { state.lastError = code ? { code, message, at: now() } : null; };
  const model = () => observer.getState().model;
  const ids = () => new Set((model()?.workspaces || []).map((w) => w.id));

  function setSelected(workspaceId, origin) {
    state.selected = { workspaceId, origin, at: now() };
    state.unavailableId = null;
  }

  function persistedChoice() {
    const last = preferences.get().lastWorkspace;
    return last && last.session === session && typeof last.workspaceId === 'string' ? last.workspaceId : null;
  }

  // Brings `selected` in line with the latest snapshot. Never sends a command.
  function reconcile() {
    const known = ids();
    if (!restored) {
      restored = true;
      const saved = persistedChoice();
      if (saved) {
        if (known.has(saved)) setSelected(saved, 'recovery'); else state.unavailableId = saved;
      }
    }
    if (state.selected && !known.has(state.selected.workspaceId)) {
      state.unavailableId = state.selected.workspaceId;
      state.selected = null;
    }
    if (state.mode === 'auto' && state.observedId && (!state.selected || state.selected.workspaceId !== state.observedId)) {
      setSelected(state.observedId, recovering ? 'recovery' : 'herdr');
    }
    if (model()) recovering = false;
  }

  function onObserver(obs) {
    if (obs.epoch !== lastEpoch) {
      if (lastEpoch !== -1 && state.pending) {
        // The connection changed under a pending request: invalidate it and show the previous selection.
        opToken += 1;
        state.selected = state.pending.previous;
        state.pending = null;
        setError('connection_lost', 'A conexao com o Herdr mudou durante a troca de workspace.');
      }
      lastEpoch = obs.epoch;
      if (obs.connection === 'connected' || obs.connection === 'disconnected') recovering = true;
    }
    if (obs.model && obs.syncCount !== lastSyncCount) {
      lastSyncCount = obs.syncCount;
      const focusId = obs.model.sessionFocus && obs.model.workspaces.some((w) => w.id === obs.model.sessionFocus.workspaceId) ? obs.model.sessionFocus.workspaceId : null;
      state.observedId = focusId;
      state.reliability = obs.model.workspaces.length === 1 ? 'only_workspace' : (focusId ? 'last_writer' : 'none');
      if (!state.pending) reconcile();
    }
    emit();
  }

  function getState() {
    const obs = observer.getState();
    return {
      ...state,
      options: (obs.model?.workspaces || []).map((w) => ({ id: w.id, number: w.number, label: w.label, directory: w.directory })),
      connection: obs.connection,
      canSelect: obs.connection === 'connected' && !state.pending
    };
  }

  // Explicit user selection (ContextDeck -> Herdr). Resolves { ok, confirmed? , noop? , stale? , error? }.
  async function select(requestSession, workspaceId) {
    if (requestSession !== session) return fail('session_mismatch', 'A sessao informada nao e a sessao configurada.');
    const obs = observer.getState();
    if (obs.connection !== 'connected' || !obs.model) return fail('not_connected', 'Sem conexao com o Herdr.');
    if (typeof workspaceId !== 'string' || !obs.model.workspaces.some((w) => w.id === workspaceId)) {
      return fail('workspace_not_found', 'Esse workspace nao existe mais na sessao.');
    }
    if (state.pending) return fail('busy', 'Uma troca de workspace ainda esta em andamento.');
    if (state.selected && state.selected.workspaceId === workspaceId && state.observedId === workspaceId) {
      remember(workspaceId);
      if (state.selected.origin !== 'dock') { state.selected = { workspaceId, origin: 'dock', at: now() }; emit(); }
      return { ok: true, noop: true, confirmed: true };
    }

    const token = ++opToken;
    const epoch = obs.epoch;
    state.pending = { workspaceId, startedAt: now(), previous: state.selected };
    setSelected(workspaceId, 'dock');
    setError(null);
    emit();

    const lost = (error) => ({ ok: false, stale: true, error: { code: error?.code || 'stale', message: error?.message || 'Operacao obsoleta descartada.' } });

    try {
      await observer.focusWorkspace(workspaceId);
    } catch (error) {
      if (token !== opToken) return lost(error);
      state.selected = state.pending.previous;
      state.pending = null;
      setError(error.code || 'focus_failed', error.message || 'Falha ao trocar de workspace.');
      emit();
      observer.refresh().catch(() => {});   // e.g. the workspace vanished: refresh the list
      return { ok: false, error: { code: error.code || 'focus_failed', message: error.message } };
    }

    let refreshError = null;
    try { await observer.refresh(); } catch (error) { refreshError = error; }
    if (token !== opToken || observer.getState().epoch !== epoch) return lost(refreshError);

    state.pending = null;
    remember(workspaceId);
    const confirmed = state.observedId === workspaceId && !refreshError;
    if (!confirmed && !refreshError && state.mode === 'auto' && state.observedId) setSelected(state.observedId, 'herdr'); // someone else moved meanwhile
    if (refreshError) setError(refreshError.code || 'refresh_failed', 'Foco enviado, mas nao foi possivel confirmar.');
    emit();
    return { ok: true, confirmed, observedId: state.observedId };
  }

  function remember(workspaceId) {
    preferences.set({ lastWorkspace: { session, workspaceId } });
  }

  function setMode(mode) {
    if (!MODES.includes(mode)) return fail('invalid_mode', 'Modo de sincronizacao invalido.');
    state.mode = mode;
    preferences.set({ mode });
    if (!state.pending) reconcile();
    emit();
    return { ok: true, mode };
  }

  return {
    start() {
      if (off) return;
      off = observer.onChange(onObserver);
      onObserver(observer.getState());
    },
    stop() {
      if (off) off();
      off = undefined;
      listeners.clear();
      opToken += 1;
    },
    select,
    setMode,
    getState,
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    _resources: () => ({ listeners: listeners.size, subscribed: Boolean(off) })
  };
}

module.exports = { createWorkspaceSelection, MODES };
