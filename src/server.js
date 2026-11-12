import { connect } from './db.js';
import { createApp } from './app.js';

const { db } = await connect();
const port = process.env.PORT ?? 3000;
createApp(db).listen(port, () => console.log(`listening on ${port}`));
