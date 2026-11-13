// A small in-memory fixed-window rate limiter.
// Single instance only: another process would keep its own counters.
export function createRateLimiter({ windowMs, max, now = Date.now, maxKeys = 10_000 }) {
  const hits = new Map(); // key -> { count, resetAt }

  function prune(t) {
    for (const [k, v] of hits) if (v.resetAt <= t) hits.delete(k);
    // Still too many live keys: drop the oldest so memory stays bounded.
    while (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
  }

  // Counts one attempt for `key`.
  function hit(key) {
    const t = now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= t) {
      if (!entry && hits.size >= maxKeys) prune(t);
      entry = { count: 0, resetAt: t + windowMs };
      hits.set(key, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= max,
      retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)),
    };
  }

  // Express middleware; `keyFn(req)` names who is being limited.
  function middleware(keyFn) {
    return (req, res, next) => {
      const { allowed, retryAfterSec } = hit(keyFn(req));
      if (allowed) return next();
      res.set('Retry-After', String(retryAfterSec));
      return res.status(429).json({ error: 'RATE_LIMITED' });
    };
  }

  return { hit, middleware };
}
