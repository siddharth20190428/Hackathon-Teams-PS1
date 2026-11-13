// Prepares the write-path load test: picks users who are in no team (with a session token
// each), a few "hot" teams with the fewest open seats (so many joiners fight for the same
// seats), and a spread of other open teams. Writes load/fixtures.json for load/mixed.js.
//
// Run after `npm run seed`:  node --env-file=.env scripts/load-fixtures.js
import { writeFileSync } from 'node:fs';
import { connect } from '../src/db.js';
import { createTokens } from '../src/auth.js';

const USERS = Number(process.env.LOAD_USERS ?? 4000);
const HOT = Number(process.env.LOAD_HOT_TEAMS ?? 5);
const WARM = Number(process.env.LOAD_WARM_TEAMS ?? 300);
const HACKATHON = process.env.HACKATHON_ID ?? 'h1';

if (!process.env.SESSION_SECRET) throw new Error('SESSION_SECRET is not set (add it to .env)');
const tokens = createTokens(process.env.SESSION_SECRET);

const { client, db } = await connect();
const busy = await db.collection('memberships').distinct('userId', { hackathonId: HACKATHON });
const free = await db
  .collection('users')
  .find({ _id: { $nin: busy } }, { projection: { _id: 1 } })
  .limit(USERS)
  .toArray();

const open = { hackathonId: HACKATHON, openSeats: { $gt: 0 } };
const hot = await db
  .collection('teams')
  .find(open, { projection: { inviteCode: 1, openSeats: 1, memberCount: 1 } })
  .sort({ openSeats: 1, _id: 1 })
  .limit(HOT)
  .toArray();
const hotIds = hot.map((t) => t._id);
const warm = await db
  .collection('teams')
  .aggregate([
    { $match: { ...open, _id: { $nin: hotIds } } },
    { $sample: { size: WARM } },
    { $project: { inviteCode: 1 } },
  ])
  .toArray();

if (free.length === 0 || hot.length === 0) {
  throw new Error('no free users or no open teams: run `npm run seed` first');
}

const fixtures = {
  createdAt: new Date().toISOString(),
  hackathonId: HACKATHON,
  users: free.map((u) => ({ id: u._id, token: tokens.issue(u._id) })),
  hot: hot.map((t) => ({
    teamId: String(t._id),
    code: t.inviteCode,
    openSeats: t.openSeats,
    memberCount: t.memberCount,
  })),
  warm: warm.map((t) => t.inviteCode),
  totals: {
    teams: await db.collection('teams').countDocuments(),
    memberships: await db.collection('memberships').countDocuments(),
  },
};
writeFileSync(new URL('../load/fixtures.json', import.meta.url), JSON.stringify(fixtures));
console.log(
  `fixtures: ${fixtures.users.length} free users, ${fixtures.hot.length} hot teams ` +
    `(open seats ${fixtures.hot.map((t) => t.openSeats).join(',')}), ${fixtures.warm.length} other open teams`,
);
await client.close();
