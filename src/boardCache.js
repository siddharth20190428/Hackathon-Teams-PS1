// A small in-process cache for the board read model.
//
// - Concurrent misses share one load, so a burst of requests costs one database query.
// - invalidate() drops everything and stops loads that were already running from storing
//   their (possibly stale) result, so a stale read can never outlive a write.
// - Single instance only: another process would not see our invalidations. The TTL bounds
//   the staleness in that case, and change streams are the planned upgrade.
export function createBoardCache({ ttlMs = 2000, maxEntries = 1000, now = Date.now } = {}) {
  const entries = new Map(); // key -> { value, expires }
  const inflight = new Map(); // key -> Promise
  let generation = 0;

  function store(key, value) {
    // Keys come from request paths, so cap the size: random ids must not grow memory.
    if (entries.size >= maxEntries && !entries.has(key)) {
      entries.delete(entries.keys().next().value);
    }
    entries.set(key, { value, expires: now() + ttlMs });
  }

  function get(key, load) {
    if (!(ttlMs > 0)) return load(); // TTL 0 turns the cache off

    const hit = entries.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);

    const running = inflight.get(key);
    if (running) return running;

    const startedIn = generation;
    const promise = load()
      .then((value) => {
        if (generation === startedIn) store(key, value);
        return value;
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  function invalidate() {
    generation++;
    entries.clear();
    inflight.clear();
  }

  return { get, invalidate };
}
