// Chaos test: kill the server with SIGKILL while a burst of joins is in flight, restart it,
// let every client retry with the SAME Idempotency-Key, then check the database.
//
//   MONGODB_URI=mongodb://localhost:27017/?replicaSet=rs0 node scripts/chaos.js
//   CHAOS_ROUNDS=5 CHAOS_CONTENDERS=40 node scripts/chaos.js
//
// It uses a throwaway database and a child server process on a free port. Exit code 0 only if:
//   1. every data invariant (src/invariants.js) holds after the crash,
//   2. no team took more people than it had seats,
//   3. every answer a client finally got agrees with the database (201 means a member row
//      exists, TEAM_FULL means it does not), so a crash never loses or invents a join.
// A join that committed just before the kill, whose retry then says ALREADY_IN_TEAM, is
// counted and reported, not hidden: the person IS in the team but was told "conflict".
// How long clients wait after the crash is reported per round: a killed server leaves open
// database transactions that hold locks until MongoDB aborts them (about 60 s).
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { MongoClient, ObjectId } from 'mongodb';
import { checkInvariants } from '../src/invariants.js';
import { ensureCoreIndexes } from '../src/indexes.js';
import { createTokens } from '../src/auth.js';

const ROUNDS = Number(process.env.CHAOS_ROUNDS ?? 4);
const CONTENDERS = Number(process.env.CHAOS_CONTENDERS ?? 40);
const TEAMS = Number(process.env.CHAOS_TEAMS ?? 3);
const BASE_URI = process.env.MONGODB_URI ?? 'mongodb://localhost:27017/?replicaSet=rs0';
const secret = randomBytes(24).toString('hex');
const dbName = `chaos_${randomUUID().slice(0, 8)}`;
const uri = (() => {
  const u = new URL(BASE_URI);
  u.pathname = `/${dbName}`;
  return u.toString();
})();
const tokens = createTokens(secret);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
let child = null;

async function startServer() {
  child = spawn(process.execPath, ['src/server.js'], {
    env: { ...process.env, MONGODB_URI: uri, SESSION_SECRET: secret, PORT: String(port), RATE_LIMITS: 'off' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const end = Date.now() + 30_000;
  while (Date.now() < end) {
    try {
      if ((await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) })).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error('server did not start');
}
const killServer = () =>
  new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });

// One request. Returns {status, body} for any HTTP answer, or {status: 0} when the connection
// failed (server killed or not yet back).
async function send(method, path, userId, body, key) {
  try {
    const res = await fetch(base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${tokens.issue(userId)}`,
        'idempotency-key': key,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20_000),
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return { status: 0, body: null };
  }
}

// A final answer is one the client can act on. Connection failures, 5xx and "still running"
// are not final: a real client retries those with the same key.
const isFinal = (r) => r.status !== 0 && r.status < 500 && r.body?.error !== 'IDEMPOTENCY_IN_PROGRESS';

const client = new MongoClient(uri);
await client.connect();
const db = client.db();
await ensureCoreIndexes(db);
await db.collection('hackathons').insertOne({ _id: 'h1', name: 'Chaos Hack', minTeamSize: 2, maxTeamSize: 4 });

let failed = false;
const fail = (m) => {
  failed = true;
  console.log(`FAIL  ${m}`);
};
const totals = { final201: 0, full: 0, committedThenConflict: 0, retries: 0, killsMidFlight: 0 };

try {
  await startServer();
  for (let round = 1; round <= ROUNDS; round++) {
    const p = `c${round}`;
    // Teams with exactly 1 open seat per 10 contenders is too tidy; use 1 to 3 open seats.
    const teams = [];
    for (let t = 0; t < TEAMS; t++) {
      const leader = `${p}-lead${t}`;
      const created = await send('POST', '/hackathons/h1/teams', leader, { name: `${p}-team-${t}` }, randomUUID());
      if (created.status !== 201) throw new Error(`setup: create team failed ${created.status}`);
      const filler = 1 + (t % 2); // 2 or 3 members already, so 2 or 1 seats remain
      const code = (await db.collection('teams').findOne({ _id: new ObjectId(created.body._id) })).inviteCode;
      for (let f = 0; f < filler - 1; f++) {
        const j = await send('POST', '/hackathons/h1/join-by-code', `${p}-fill${t}-${f}`, { code }, randomUUID());
        if (j.status !== 201) throw new Error(`setup: fill failed ${j.status}`);
      }
      const team = await db.collection('teams').findOne({ _id: new ObjectId(created.body._id) });
      teams.push({ id: String(team._id), code: team.inviteCode, seatsBefore: team.openSeats });
    }

    // The burst: every contender joins one team, keyed so a retry is the same request.
    const jobs = Array.from({ length: CONTENDERS }, (_, i) => {
      const team = teams[i % TEAMS];
      return { user: `${p}-u${i}`, team, key: `chaos-${randomUUID()}`, result: null };
    });
    const fire = (job) =>
      send('POST', '/hackathons/h1/join-by-code', job.user, { code: job.team.code }, job.key).then((r) => {
        job.result = r;
      });
    const inFlight = jobs.map(fire);

    // Kill at a different moment each round, while requests are being processed.
    const killAfter = 15 + Math.floor(Math.random() * 120);
    await sleep(killAfter);
    const unfinished = jobs.filter((j) => !j.result || !isFinal(j.result)).length;
    await killServer();
    totals.killsMidFlight += unfinished;
    await Promise.allSettled(inFlight);
    await startServer();

    // Retry, with the same key, everything that has no final answer. A key left "processing" by
    // the dead process is waited out (the server treats it as abandoned after 30 s).
    const retryStart = Date.now();
    const deadline = retryStart + 180_000;
    for (;;) {
      const pending = jobs.filter((j) => !j.result || !isFinal(j.result));
      if (!pending.length) break;
      if (Date.now() > deadline) {
        fail(`round ${round}: ${pending.length} client(s) never got a final answer in 180 s`);
        break;
      }
      totals.retries += pending.length;
      await Promise.all(pending.map(fire));
      if (jobs.some((j) => !isFinal(j.result))) await sleep(2000);
    }

    // Compare what each client was told with what the database says.
    for (const job of jobs) {
      const row = await db.collection('memberships').findOne({ hackathonId: 'h1', userId: job.user });
      const inTeam = row && String(row.teamId) === job.team.id;
      const { status, body } = job.result ?? { status: 0, body: null };
      if (status === 201) {
        totals.final201++;
        if (!inTeam) fail(`${job.user} was told 201 but has no membership (lost join)`);
      } else if (body?.error === 'TEAM_FULL' || body?.error === 'TEAM_LOCKED') {
        totals.full++;
        if (inTeam) fail(`${job.user} was told ${body.error} but is a member (phantom join)`);
      } else if (body?.error === 'ALREADY_IN_TEAM') {
        // The join committed, the response was lost, and the retry found the person already in.
        if (inTeam) totals.committedThenConflict++;
        else fail(`${job.user} was told ALREADY_IN_TEAM but is not in the team`);
      } else if (job.result) {
        fail(`${job.user} final answer ${status} ${body?.error}`);
      }
    }
    for (const t of teams) {
      const doc = await db.collection('teams').findOne({ _id: new ObjectId(t.id) });
      const joined = doc.memberCount - (4 - t.seatsBefore);
      if (doc.openSeats < 0 || joined > t.seatsBefore) fail(`team ${t.id}: ${joined} joined for ${t.seatsBefore} seats`);
    }
    const problems = await checkInvariants(db);
    if (problems.length) fail(`round ${round}: ${problems.length} invariant violation(s), first: ${problems[0]}`);
    console.log(
      `round ${round}: killed at ${killAfter} ms, ${jobs.filter((j) => j.result?.status === 201).length}/${CONTENDERS} joined, ` +
        `invariants ${problems.length ? 'BROKEN' : 'ok'}, all clients answered after ${Math.round((Date.now() - retryStart) / 1000)} s`,
    );
  }
} finally {
  if (child && child.exitCode === null) await killServer();
  await db.dropDatabase().catch(() => {});
  await client.close();
}
console.log(
  `summary: ${totals.killsMidFlight} requests without an answer at kill time, ${totals.retries} retries, ` +
    `${totals.final201} joins confirmed, ${totals.full} told full, ` +
    `${totals.committedThenConflict} committed before the kill but answered ALREADY_IN_TEAM on retry`,
);
console.log(failed ? 'CHAOS FAILED' : 'CHAOS PASSED');
process.exit(failed ? 1 : 0);
