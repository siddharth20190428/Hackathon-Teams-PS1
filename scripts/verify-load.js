// Checks the database after a write-path load run: every data invariant must hold, and for
// the hot teams no more people joined than there were open seats.
//
// Run after load/mixed.js:  node --env-file=.env scripts/verify-load.js
import { readFileSync } from 'node:fs';
import { ObjectId } from 'mongodb';
import { connect } from '../src/db.js';
import { checkInvariants } from '../src/invariants.js';

const fixtures = JSON.parse(readFileSync(new URL('../load/fixtures.json', import.meta.url), 'utf8'));
const { client, db } = await connect();
let failed = false;
const fail = (message) => {
  failed = true;
  console.log(`FAIL ${message}`);
};

const problems = await checkInvariants(db);
if (problems.length) {
  fail(`${problems.length} invariant violation(s), first: ${JSON.stringify(problems[0])}`);
} else {
  console.log('invariants ok');
}

for (const h of fixtures.hot) {
  const team = await db.collection('teams').findOne({ _id: new ObjectId(h.teamId) });
  if (!team) {
    console.log(`hot team ${h.teamId}: gone (deleted during the run)`);
    continue;
  }
  const rows = await db.collection('memberships').countDocuments({ teamId: team._id });
  const joined = team.memberCount - h.memberCount;
  console.log(
    `hot team ${h.teamId}: open seats ${h.openSeats} -> ${team.openSeats}, joined ${joined}, member rows ${rows}`,
  );
  if (team.openSeats < 0) fail(`team ${h.teamId} has negative open seats`);
  if (rows !== team.memberCount) fail(`team ${h.teamId} count ${team.memberCount} != rows ${rows}`);
  if (joined > h.openSeats) fail(`team ${h.teamId} took ${joined} joiners for ${h.openSeats} seats`);
}

const teams = await db.collection('teams').countDocuments();
const memberships = await db.collection('memberships').countDocuments();
console.log(
  `teams ${fixtures.totals.teams} -> ${teams}, memberships ${fixtures.totals.memberships} -> ${memberships}`,
);
await client.close();
process.exitCode = failed ? 1 : 0;
console.log(failed ? 'LOAD VERIFY FAILED' : 'LOAD VERIFY PASSED');
