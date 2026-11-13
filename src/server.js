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

const port = process.env.PORT ?? 3000;
createApp(db, client, {
  secret,
  boardEvents: createBoardEvents(),
  // RATE_LIMITS=off is for write-path load tests only: from one IP the limits would trip at once.
  rateLimits: process.env.RATE_LIMITS === 'off' ? false : undefined,
  boardCache: createBoardCache({ ttlMs }),
  trustProxy: process.env.TRUST_PROXY ? Number(process.env.TRUST_PROXY) : false,
}).listen(port, () =>
  console.log(`listening on ${port} (board cache ttl ${ttlMs} ms${process.env.RATE_LIMITS === 'off' ? ', RATE LIMITS OFF' : ''})`),
);
