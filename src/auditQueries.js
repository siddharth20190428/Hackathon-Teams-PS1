import { httpError } from './errors.js';
import { toId } from './teams.js';

// Team members can read their team's log, newest first.
export async function listAudit(db, { teamId, actorId, limit = 50 }) {
  const _id = toId(teamId);
  const member = await db
    .collection('memberships')
    .findOne({ teamId: _id, userId: actorId }, { projection: { _id: 1 } });
  if (!member) {
    const exists = await db.collection('teams').findOne({ _id }, { projection: { _id: 1 } });
    throw httpError(exists ? 403 : 404, exists ? 'NOT_MEMBER' : 'NOT_FOUND');
  }
  const n = limit; // already checked: a whole number from 1 to 200
  const entries = await db
    .collection('auditLog')
    .find({ teamId: _id }, { projection: { hackathonId: 0 } })
    .sort({ ts: -1, _id: -1 })
    .limit(n)
    .toArray();
  return { entries };
}
