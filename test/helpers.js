import { MongoClient } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';

export async function setup() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(`test_${randomUUID().slice(0, 8)}`);
  await db
    .collection('hackathons')
    .insertOne({ _id: 'h1', name: 'Test Hack', minTeamSize: 2, maxTeamSize: 4 });

  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, userId, body) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(userId ? { 'x-user-id': userId } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  const teardown = async () => {
    server.closeAllConnections?.();
    server.close();
    await db.dropDatabase();
    await client.close();
  };

  return { db, call, teardown };
}
