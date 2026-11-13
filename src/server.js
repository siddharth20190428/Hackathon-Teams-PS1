import { connect } from './db.js';
import { createApp } from './app.js';
import { createBoardCache } from './boardCache.js';
import { ensureCoreIndexes } from './indexes.js';

const { client, db } = await connect();
await ensureCoreIndexes(db);

// BOARD_CACHE_TTL_MS=0 turns the board cache off (useful for A/B load tests).
const parsed = Number.parseInt(process.env.BOARD_CACHE_TTL_MS ?? '', 10);
const ttlMs = Number.isNaN(parsed) ? 2000 : parsed;

const port = process.env.PORT ?? 3000;
createApp(db, client, { boardCache: createBoardCache({ ttlMs }) }).listen(port, () =>
  console.log(`listening on ${port} (board cache ttl ${ttlMs} ms)`),
);
