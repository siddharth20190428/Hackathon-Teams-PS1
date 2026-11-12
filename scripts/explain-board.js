import { connect } from '../src/db.js';

const { client, db } = await connect();

const explain = await db
  .collection('teams')
  .find({ hackathonId: 'h1', lookingForTeammates: true, openSeats: { $gt: 0 } })
  .sort({ createdAt: -1, _id: -1 })
  .limit(20)
  .explain('executionStats');

const plan = explain.queryPlanner.winningPlan;
const root = plan.queryPlan ?? plan; // newer servers nest the plan under queryPlan
const stages = [];
(function walk(node) {
  if (!node) return;
  stages.push(node.stage);
  walk(node.inputStage);
  (node.inputStages ?? []).forEach(walk);
})(root);

const s = explain.executionStats;
console.log({
  plan: stages.join(' > '),
  indexName: root.inputStage?.indexName ?? root.inputStage?.inputStage?.indexName ?? null,
  docsExamined: s.totalDocsExamined,
  keysExamined: s.totalKeysExamined,
  returned: s.nReturned,
  serverMs: s.executionTimeMillis,
});
await client.close();
