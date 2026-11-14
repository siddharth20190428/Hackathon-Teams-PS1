import { ObjectId } from 'mongodb';
import { httpError } from './errors.js';
import { runTransaction } from './tx.js';
import { toId, isMembershipDuplicate } from './teams.js';
import { cancelUserRequests } from './requestCleanup.js';
import { audit } from './audit.js';

const isDuplicateKey = (err) => err?.code === 11000;

async function leaderOrThrow(db, _id, actorId, options = {}) {
  const team = await db.collection('teams').findOne({ _id, leaderId: actorId }, { projection: { _id: 1 }, ...options });
  if (team) return;
  const exists = await db.collection('teams').findOne({ _id }, { projection: { _id: 1 }, ...options });
  throw httpError(exists ? 403 : 404, exists ? 'NOT_LEADER' : 'NOT_FOUND');
}

export async function createJoinRequest(db, client, { teamId, userId }) {
  const _id = toId(teamId);
  const first = await db.collection('teams').findOne({ _id }, { projection: { hackathonId: 1 } });
  if (!first) throw httpError(404, 'NOT_FOUND');
  const member = await db
    .collection('memberships')
    .findOne({ hackathonId: first.hackathonId, userId }, { projection: { _id: 1 } });
  if (member) throw httpError(409, 'ALREADY_IN_TEAM');

  const request = {
    _id: new ObjectId(),
    hackathonId: first.hackathonId,
    teamId: _id,
    userId,
    status: 'pending',
    createdAt: new Date(),
  };
  const team = first;
  try {
    // The partial unique index on (teamId, userId) where status is pending rejects a duplicate.
    await runTransaction(client, async (session) => {
      // Touching the team document in this transaction is what makes "locked" safe: a lock that
      // commits meanwhile conflicts with this write, and the retry sees the team locked. Without
      // it, a request could slip in just after the lock cancelled the pending ones.
      const live = await db
        .collection('teams')
        .findOneAndUpdate({ _id, locked: { $ne: true } }, { $inc: { version: 1 } }, { returnDocument: 'after', session, projection: { openSeats: 1 } });
      if (!live) throw httpError(409, 'TEAM_LOCKED');
      if (live.openSeats <= 0) throw httpError(409, 'TEAM_FULL');
      await db.collection('joinRequests').insertOne(request, { session });
      await audit(db, session, {
        action: 'JOIN_REQUESTED',
        hackathonId: team.hackathonId,
        teamId: _id,
        targetUserId: userId,
        summary: { requestId: String(request._id) },
      });
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw httpError(409, 'ALREADY_REQUESTED');
    throw err;
  }
  return { requestId: String(request._id), teamId, userId, status: 'pending' };
}

export async function listJoinRequests(db, { teamId, actorId }) {
  const _id = toId(teamId);
  await leaderOrThrow(db, _id, actorId);
  const requests = await db
    .collection('joinRequests')
    .find({ teamId: _id, status: 'pending' })
    .sort({ createdAt: 1, _id: 1 })
    .limit(100)
    .toArray();
  return { requests };
}

export async function acceptJoinRequest(db, client, { teamId, requestId, actorId }) {
  const _id = toId(teamId);
  const rid = toId(requestId);
  try {
    return await runTransaction(client, async (session) => {
      // 1. Claim the seat. The leader check is part of the atomic filter, so a leadership
      //    change that lands mid-flight cannot be bypassed, and non-leaders learn nothing
      //    about the request.
      const team = await db.collection('teams').findOneAndUpdate(
        { _id, leaderId: actorId, openSeats: { $gt: 0 }, locked: { $ne: true } },
        { $inc: { memberCount: 1, openSeats: -1, version: 1 } },
        { returnDocument: 'after', session },
      );
      if (!team) {
        const t = await db.collection('teams').findOne({ _id }, { session, projection: { leaderId: 1, locked: 1 } });
        if (!t) throw httpError(404, 'NOT_FOUND');
        if (t.leaderId !== actorId) throw httpError(403, 'NOT_LEADER');
        if (t.locked) throw httpError(409, 'TEAM_LOCKED');
        throw httpError(409, 'TEAM_FULL');
      }

      // 2. Decide the request. Only a pending request can be accepted; if it is not,
      //    the transaction aborts and the seat claim above is rolled back.
      const request = await db.collection('joinRequests').findOneAndUpdate(
        { _id: rid, teamId: _id, status: 'pending' },
        { $set: { status: 'accepted', decidedAt: new Date() } },
        { returnDocument: 'after', session },
      );
      if (!request) {
        const known = await db
          .collection('joinRequests')
          .findOne({ _id: rid, teamId: _id }, { session, projection: { _id: 1 } });
        throw httpError(known ? 409 : 404, known ? 'ALREADY_DECIDED' : 'NOT_FOUND');
      }

      // 3. Add the member. The unique membership index rejects someone already in a team.
      await db.collection('memberships').insertOne(
        { hackathonId: team.hackathonId, teamId: _id, userId: request.userId, role: 'member', joinedAt: new Date() },
        { session },
      );

      // 4. Their other pending requests are now void.
      await cancelUserRequests(db, session, team.hackathonId, request.userId);
      await audit(db, session, {
        action: 'MEMBER_JOINED',
        hackathonId: team.hackathonId,
        teamId: _id,
        targetUserId: request.userId,
        summary: { via: 'join_request', requestId: String(rid) },
      });
      return { requestId: String(rid), teamId, userId: request.userId };
    });
  } catch (err) {
    if (isMembershipDuplicate(err)) {
      // The requester joined a team after asking (a request that slipped in after they joined).
      // Void it so it does not linger in the leader's list.
      await db
        .collection('joinRequests')
        .updateOne({ _id: rid, status: 'pending' }, { $set: { status: 'cancelled', decidedAt: new Date() } });
      throw httpError(409, 'REQUESTER_UNAVAILABLE');
    }
    throw err;
  }
}

export async function declineJoinRequest(db, client, { teamId, requestId, actorId }) {
  const _id = toId(teamId);
  const rid = toId(requestId);
  return runTransaction(client, async (session) => {
    // Touching the team document with the leader filter serializes this with leadership changes.
    const team = await db
      .collection('teams')
      .findOneAndUpdate({ _id, leaderId: actorId }, { $inc: { version: 1 } }, { session, projection: { _id: 1 } });
    if (!team) await leaderOrThrow(db, _id, actorId, { session });

    const request = await db.collection('joinRequests').findOneAndUpdate(
      { _id: rid, teamId: _id, status: 'pending' },
      { $set: { status: 'declined', decidedAt: new Date() } },
      { returnDocument: 'after', session },
    );
    if (!request) {
      const known = await db
        .collection('joinRequests')
        .findOne({ _id: rid, teamId: _id }, { session, projection: { _id: 1 } });
      throw httpError(known ? 409 : 404, known ? 'ALREADY_DECIDED' : 'NOT_FOUND');
    }
    await audit(db, session, {
      action: 'JOIN_REQUEST_DECLINED',
      hackathonId: request.hackathonId,
      teamId: _id,
      targetUserId: request.userId,
      summary: { requestId: String(rid) },
    });
    return { requestId: String(rid), status: 'declined' };
  });
}

export async function cancelJoinRequest(db, client, { teamId, requestId, userId }) {
  const _id = toId(teamId);
  const rid = toId(requestId);
  return runTransaction(client, async (session) => {
    const request = await db.collection('joinRequests').findOneAndUpdate(
      { _id: rid, teamId: _id, userId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { returnDocument: 'after', session },
    );
    if (!request) {
      const mine = await db
        .collection('joinRequests')
        .findOne({ _id: rid, teamId: _id, userId }, { session, projection: { _id: 1 } });
      throw httpError(mine ? 409 : 404, mine ? 'ALREADY_DECIDED' : 'NOT_FOUND');
    }
    await audit(db, session, {
      action: 'JOIN_REQUEST_CANCELLED',
      hackathonId: request.hackathonId,
      teamId: _id,
      targetUserId: userId,
      summary: { requestId: String(rid) },
    });
    return { requestId: String(rid), status: 'cancelled' };
  });
}
