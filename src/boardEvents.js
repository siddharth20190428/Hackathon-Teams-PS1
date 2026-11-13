// Server-sent events for the board: a "something changed" signal, not the data.
//
// Why a signal: the board is one cached body shared by everyone. When it changes, every
// open page re-reads it, and the cache turns that burst into one database query. Pushing
// the data itself would need a second, per-viewer rendering path to keep correct.
//
// - publish() is called after the board cache is invalidated, so a client that reacts to an
//   event and re-reads the board never gets the old body.
// - Bursts are coalesced: any number of writes inside one window produce one event.
// - Every event carries a version. A client that sees a gap or reconnects just re-reads.
// - Bounded: total streams, streams per user, and slow clients are dropped.
// - Single instance only: another process has its own streams and would not hear our writes.
//   Change streams are the upgrade path (the same as for the board cache).
export function createBoardEvents({
  coalesceMs = 100,
  heartbeatMs = 25_000,
  maxStreams = 2000,
  maxPerUser = 5,
  maxBufferedBytes = 64 * 1024,
} = {}) {
  const streams = new Map(); // res -> userId
  const perUser = new Map(); // userId -> count
  let version = 0;
  let timer = null;
  let heartbeat = null;

  const write = (res, chunk) => {
    if (res.writableLength > maxBufferedBytes) {
      remove(res); // a client that is not reading must not hold memory
      res.destroy();
      return;
    }
    res.write(chunk);
  };

  function remove(res) {
    const userId = streams.get(res);
    if (userId === undefined) return;
    streams.delete(res);
    const left = (perUser.get(userId) ?? 1) - 1;
    if (left > 0) perUser.set(userId, left);
    else perUser.delete(userId);
    if (streams.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  function flush() {
    timer = null;
    const message = `id: ${version}\nevent: board\ndata: {"version":${version}}\n\n`;
    for (const res of [...streams.keys()]) write(res, message);
  }

  function publish() {
    version++;
    if (!timer) timer = setTimeout(flush, coalesceMs);
  }

  // Returns { ok: true } once the stream is open, or { ok: false, status, error } if refused.
  function subscribe(req, res, userId) {
    if (streams.size >= maxStreams) return { ok: false, status: 503, error: 'TOO_MANY_STREAMS' };
    if ((perUser.get(userId) ?? 0) >= maxPerUser) return { ok: false, status: 429, error: 'TOO_MANY_STREAMS_FOR_USER' };

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // proxies must not hold the stream back
    });
    res.flushHeaders();
    res.write(`retry: 3000\nevent: ready\ndata: {"version":${version}}\n\n`);

    streams.set(res, userId);
    perUser.set(userId, (perUser.get(userId) ?? 0) + 1);
    if (!heartbeat) {
      // Comment lines keep idle connections open through proxies with idle timeouts.
      heartbeat = setInterval(() => {
        for (const s of [...streams.keys()]) write(s, ': ping\n\n');
      }, heartbeatMs);
      heartbeat.unref();
    }
    const done = () => remove(res);
    req.on('close', done);
    res.on('close', done);
    return { ok: true };
  }

  function close() {
    if (timer) clearTimeout(timer);
    if (heartbeat) clearInterval(heartbeat);
    timer = heartbeat = null;
    for (const res of [...streams.keys()]) {
      remove(res);
      res.end();
    }
  }

  return { publish, subscribe, close, size: () => streams.size, version: () => version };
}
