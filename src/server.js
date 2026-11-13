import { connect } from './db.js';
import { createApp } from './app.js';
import { createBoardCache } from './boardCache.js';
import { createBoardEvents } from './boardEvents.js';
import { ensureCoreIndexes } from './indexes.js';

const { client, db } = await connect();
await ensureCoreIndexes(db);

// BOARD_CACHE_TTL_MS=0 turns the board cache off (useful for A/B load tests).
const parsed = Number.parseInt(process.env.BOARD_CACHE_TTL_MS ?? '', 10);
const ttlMs = Number.isNaN(parsed) ? 2000 : parsed;

const secret = process.env.SESSION_SECRET;
if (!secret || secret.length < 32) {
  throw new Error('SESSION_SECRET must be set to a random string of at least 32 characters (see README.md)');
}

const events = createBoardEvents();
const port = process.env.PORT ?? 3000;
const server = createApp(db, client, {
  secret,
  boardEvents: events,
  // RATE_LIMITS=off is for write-path load tests only: from one IP the limits would trip at once.
  rateLimits: process.env.RATE_LIMITS === 'off' ? false : undefined,
  boardCache: createBoardCache({ ttlMs }),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
}).listen(port, () =>
  console.log(`listening on ${port} (board cache ttl ${ttlMs} ms${process.env.RATE_LIMITS === 'off' ? ', RATE LIMITS OFF' : ''})`),
);

// A deploy sends SIGTERM: stop taking requests, let running ones finish, close the live
// streams (they never finish on their own), then close the database connection.
let stopping = false;
function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} received, shutting down`);
  events.close();
  server.close(async () => {
    await client.close().catch(() => {});
    process.exit(0);
  });
  setTimeout(() => server.closeAllConnections?.(), 5000).unref(); // keep-alive leftovers
  setTimeout(() => process.exit(1), 10_000).unref(); // never hang a deploy
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
