import { connect } from './db.js';
import { createApp } from './app.js';
import { ensureCoreIndexes } from './indexes.js';

const { client, db } = await connect();
await ensureCoreIndexes(db);
const port = process.env.PORT ?? 3000;
createApp(db, client).listen(port, () => console.log(`listening on ${port}`));
