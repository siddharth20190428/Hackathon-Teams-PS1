import { createHash } from 'node:crypto';

// Every POST and DELETE carries an Idempotency-Key. The first request with a key claims it
// and runs; a retry with the same key and the same request gets the stored response back
// instead of running again. Keys are scoped to the person who sent them.

const KEY_FORMAT = /^[A-Za-z0-9_.:-]{8,128}$/;
const STALE_MS = 30_000; // a record still "processing" after this long is presumed abandoned
const WAIT_MS = 10_000; // how long a duplicate waits for the first request to finish
const POLL_MS = 25;

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

// The same key must always mean the same request: method, path, query and body.
export const hashRequest = (req) =>
  createHash('sha256')
    .update(`${req.method} ${req.originalUrl}\n${stableStringify(req.body ?? null)}`)
    .digest('hex');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tryClaim(keys, scope, requestHash) {
  try {
    const now = new Date();
    await keys.insertOne({ ...scope, requestHash, state: 'processing', startedAt: now, createdAt: now });
    return true;
  } catch (err) {
    if (err?.code === 11000) return false;
    throw err;
  }
}

// We own the key: let the request run, and store its response before sending it.
function execute(res, next, keys, scope) {
  let finalized = false;
  const json = res.json.bind(res);
  res.json = (body) => {
    const status = res.statusCode;
    finalized = true;
    // A server error is not a final answer: release the key so a retry really runs again.
    const persist =
      status >= 500
        ? keys.deleteOne({ ...scope, state: 'processing' })
        : keys.updateOne(scope, { $set: { state: 'done', status, body, finishedAt: new Date() } });
    persist.catch((err) => console.error('idempotency record not saved', err)).finally(() => json(body));
    return res;
  };
  // Safety net: a response that never went through res.json releases the key.
  res.on('finish', () => {
    if (!finalized) keys.deleteOne({ ...scope, state: 'processing' }).catch(() => {});
  });
  next();
}

export function idempotency(db) {
  const keys = db.collection('idempotencyKeys');

  return async function idempotencyMiddleware(req, res, next) {
    try {
      if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

      const key = req.get('idempotency-key');
      if (!key) return res.status(400).json({ error: 'IDEMPOTENCY_KEY_REQUIRED' });
      if (!KEY_FORMAT.test(key)) return res.status(400).json({ error: 'INVALID_IDEMPOTENCY_KEY' });

      const requestHash = hashRequest(req);
      const scope = { userId: req.userId, key };
      const deadline = Date.now() + WAIT_MS;

      for (;;) {
        if (await tryClaim(keys, scope, requestHash)) return execute(res, next, keys, scope);

        const existing = await keys.findOne(scope);
        if (!existing) continue; // released between our insert and our read: claim again

        if (existing.requestHash !== requestHash) {
          return res.status(422).json({ error: 'IDEMPOTENCY_KEY_REUSED' });
        }
        if (existing.state === 'done') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(existing.status).json(existing.body);
        }
        if (Date.now() - existing.startedAt.getTime() > STALE_MS) {
          const took = await keys.findOneAndUpdate(
            { _id: existing._id, state: 'processing', startedAt: existing.startedAt },
            { $set: { startedAt: new Date() } },
          );
          if (took) return execute(res, next, keys, scope);
          continue;
        }
        // The first request is still running: wait for it, so parallel duplicates get the
        // same answer instead of an error.
        if (Date.now() >= deadline) {
          res.set('Retry-After', '1');
          return res.status(409).json({ error: 'IDEMPOTENCY_IN_PROGRESS' });
        }
        await sleep(POLL_MS);
      }
    } catch (err) {
      next(err);
    }
  };
}
