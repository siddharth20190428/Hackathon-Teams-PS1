import { ObjectId } from 'mongodb';
import { connect } from '../src/db.js';
import { checkInvariants } from '../src/invariants.js';
import { ensureCoreIndexes } from '../src/indexes.js';
import { newInviteCode } from '../src/inviteCodes.js';

const USERS = Number(process.env.SEED_USERS ?? 10000);
const TEAMS = Number(process.env.SEED_TEAMS ?? 2000);
const MAX = 4;
const SKILLS = ['frontend', 'backend', 'design', 'ml', 'devops', 'mobile', 'product'];
const OFFSETS = [-480, -300, 0, 60, 330, 480, 540];

const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, n);

async function insertBatches(col, docs, size = 1000) {
  for (let i = 0; i < docs.length; i += size) {
    await col.insertMany(docs.slice(i, i + size), { ordered: false });
  }
}

const { client, db } = await connect();
if (!/dev|seed/.test(db.databaseName)) {
  throw new Error(`Refusing to wipe database "${db.databaseName}"`);
}
await db.dropDatabase();
await ensureCoreIndexes(db);

await db
  .collection('hackathons')
  .insertOne({ _id: 'h1', name: 'Seed Hack', minTeamSize: 2, maxTeamSize: MAX, inviteTtlHours: 48 });

const users = Array.from({ length: USERS }, (_, i) => ({
  _id: `u${i}`,
  email: `u${i}@example.test`,
  displayName: `User ${i}`,
  skills: pick(SKILLS, 2),
  utcOffsetMinutes: OFFSETS[i % OFFSETS.length],
}));
await insertBatches(db.collection('users'), users);

const usedCodes = new Set();
const uniqueCode = () => {
  let code;
  do code = newInviteCode();
  while (usedCodes.has(code));
  usedCodes.add(code);
  return code;
};

const teams = [];
const memberships = [];
const now = Date.now();
let next = 0;
for (let t = 0; t < TEAMS; t++) {
  const size = 1 + Math.floor(Math.random() * MAX);
  if (next + size > USERS) break;
  const members = users.slice(next, next + size);
  next += size;
  const _id = new ObjectId();
  teams.push({
    _id,
    hackathonId: 'h1',
    name: `Team ${t}`,
    leaderId: members[0]._id,
    leaderName: members[0].displayName,
    maxSize: MAX,
    memberCount: size,
    openSeats: MAX - size,
    inviteCode: uniqueCode(),
    inviteExpiresAt: new Date(now + 48 * 3600 * 1000),
    lookingForTeammates: size < MAX,
    version: 1,
    createdAt: new Date(now - t * 1000),
  });
  members.forEach((m, k) =>
    memberships.push({
      hackathonId: 'h1',
      teamId: _id,
      userId: m._id,
      role: k === 0 ? 'leader' : 'member',
      joinedAt: new Date(now - t * 1000 + k),
    }),
  );
}
await insertBatches(db.collection('teams'), teams);
await insertBatches(db.collection('memberships'), memberships);

console.log(
  `seeded ${users.length} users, ${teams.length} teams, ${memberships.length} memberships`,
);
const problems = await checkInvariants(db);
console.log(problems.length ? problems.slice(0, 5) : 'invariants ok');
if (problems.length) process.exitCode = 1;
await client.close();
