import { MongoClient, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ensureCoreIndexes } from '../src/indexes.js';

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';

export async function setup() {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(`test_${randomUUID().slice(0, 8)}`);
  await ensureCoreIndexes(db);
  await db
    .collection('hackathons')
    .insertOne({ _id: 'h1', name: 'Test Hack', minTeamSize: 2, maxTeamSize: 4 });

  const server = createApp(db, client).listen(0);
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

  const codeOf = async (teamId) =>
    (await db.collection('teams').findOne({ _id: new ObjectId(teamId) }))?.inviteCode;
  const joinByCode = (code, userId) => call('POST', '/hackathons/h1/join-by-code', userId, { code });
  // Convenience for sequential setup. Races read the code first and use joinByCode.
  const join = async (teamId, userId) => joinByCode((await codeOf(teamId)) ?? 'ZZZZZZZZZZ', userId);

  const teardown = async () => {
    server.closeAllConnections?.();
    server.close();
    await db.dropDatabase();
    await client.close();
  };

  return { db, call, codeOf, joinByCode, join, teardown };
}
