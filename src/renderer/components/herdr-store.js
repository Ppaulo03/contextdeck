// Single subscription to the Herdr state pushed by the main process. Components read from here
// instead of each registering its own IPC listener and requesting the initial state again.
export function createHerdrStore(dock) {
  let state = null;
  const subscribers = new Set();

  function apply(next) {
    if (!next) return;
    state = next;
    for (const subscriber of [...subscribers]) subscriber(state);
  }

  const off = dock.onHerdrState(apply);
  // Pushes are authoritative; the initial read only fills the gap until the first push arrives.
  void dock.herdrState().then((initial) => { if (!state) apply(initial); });

  return {
    get: () => state,
    apply,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      if (state) subscriber(state);
      return () => subscribers.delete(subscriber);
    },
    dispose() { off(); subscribers.clear(); }
  };
}
