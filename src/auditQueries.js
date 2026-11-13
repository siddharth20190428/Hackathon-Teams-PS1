import { httpError } from './errors.js';
import { toId } from './teams.js';

// Team members can read their team's log, newest first.
export async function listAudit(db, { teamId, actorId, limit }) {
  const _id = toId(teamId);
  const member = await db
    .collection('memberships')
    .findOne({ teamId: _id, userId: actorId }, { projection: { _id: 1 } });
  if (!member) {
    const exists = await db.collection('teams').findOne({ _id }, { projection: { _id: 1 } });
    throw httpError(exists ? 403 : 404, exists ? 'NOT_MEMBER' : 'NOT_FOUND');
  }
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
  const entries = await db
    .collection('auditLog')
    .find({ teamId: _id }, { projection: { hackathonId: 0 } })
    .sort({ ts: -1, _id: -1 })
    .limit(n)
    .toArray();
  return { entries };
}
