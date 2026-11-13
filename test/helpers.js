import { MongoClient, ObjectId } from 'mongodb';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { ensureCoreIndexes } from '../src/indexes.js';
import { createTokens } from '../src/auth.js';

const URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';

export const TEST_SECRET = 'test-secret-0123456789abcdef0123456789abcdef';

// options: passed to createApp; rate limits are off unless a test asks for them.
export async function setup(options = {}) {
  const client = new MongoClient(URI);
  await client.connect();
  const db = client.db(`test_${randomUUID().slice(0, 8)}`);
  await ensureCoreIndexes(db);
  await db
    .collection('hackathons')
    .insertOne({ _id: 'h1', name: 'Test Hack', minTeamSize: 2, maxTeamSize: 4 });

  const tokens = createTokens(TEST_SECRET);
  const server = createApp(db, client, { secret: TEST_SECRET, rateLimits: false, ...options }).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  // Sessions are stateless, so a test can act as any user id without creating the account.
  const tokenFor = (userId, opts) => tokens.issue(userId, opts);

  // Every write gets a fresh Idempotency-Key unless the test passes its own in `headers`
  // (set a header to null to send none).
  const call = async (method, path, userId, body, headers = {}) => {
    const merged = {
      'content-type': 'application/json',
      ...(userId ? { authorization: `Bearer ${tokenFor(userId)}` } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }),
      ...headers,
    };
    for (const k of Object.keys(merged)) if (merged[k] == null) delete merged[k];
    const res = await fetch(base + path, {
      method,
      headers: merged,
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };

  // A raw request with no automatic headers, for cookies and malformed input.
  const raw = async (method, path, { headers = {}, body, rawBody } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
  };

  const codeOf = async (teamId) =>
    (await db.collection('teams').findOne({ _id: new ObjectId(teamId) }))?.inviteCode;
  const joinByCode = (code, userId, headers) => call('POST', '/hackathons/h1/join-by-code', userId, { code }, headers);
  // Convenience for sequential setup. Races read the code first and use joinByCode.
  const join = async (teamId, userId) => joinByCode((await codeOf(teamId)) ?? 'ZZZZZZZZZZ', userId);

  const teardown = async () => {
    server.closeAllConnections?.();
    server.close();
    await db.dropDatabase();
    await client.close();
  };

  return { db, base, call, raw, tokenFor, codeOf, joinByCode, join, teardown };
}
