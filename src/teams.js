import { ObjectId } from 'mongodb';
import { httpError } from './errors.js';
import { runTransaction } from './tx.js';
import { newInviteCode, normalizeCode, isValidCode } from './inviteCodes.js';
import { cancelUserRequests, cancelTeamRequests } from './requestCleanup.js';
import { audit } from './audit.js';

export const toId = (s) => {
  if (!ObjectId.isValid(s)) throw httpError(404, 'NOT_FOUND');
  return new ObjectId(s);
};

const isDuplicateKey = (err) => err?.code === 11000;
const isInviteCodeCollision = (err) => isDuplicateKey(err) && err.keyPattern?.inviteCode !== undefined;
export const isMembershipDuplicate = (err) => isDuplicateKey(err) && !isInviteCodeCollision(err);

// Invite codes are secrets: they never appear on the board or on the public team view.
const PUBLIC_TEAM = { inviteCode: 0, inviteExpiresAt: 0 };

// Names shown to other people. Falls back to the id for accounts without a profile.
async function displayNameOf(db, userId, session) {
  const user = await db.collection('users').findOne({ _id: userId }, { session, projection: { displayName: 1 } });
  return user?.displayName ?? userId;
}

const inviteExpiry = (hack) => new Date(Date.now() + (hack?.inviteTtlHours ?? 48) * 3600 * 1000);

export async function createTeam(db, client, { hackathonId, userId, name }) {
  const hack = await db.collection('hackathons').findOne({ _id: hackathonId });
  if (!hack) throw httpError(404, 'HACKATHON_NOT_FOUND');
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'INVALID_NAME');

  for (let attempt = 0; attempt < 3; attempt++) {
    const team = {
      _id: new ObjectId(),
      hackathonId,
      name: name.trim(),
      leaderId: userId,
      leaderName: await displayNameOf(db, userId),
      maxSize: hack.maxTeamSize,
      memberCount: 1,
      openSeats: hack.maxTeamSize - 1,
      inviteCode: newInviteCode(),
      inviteExpiresAt: inviteExpiry(hack),
      lookingForTeammates: true,
      version: 1,
      createdAt: new Date(),
    };
    try {
      await runTransaction(client, async (session) => {
        // Membership first: the unique index rejects a second team for the same person.
        await db.collection('memberships').insertOne(
          { hackathonId, teamId: team._id, userId, role: 'leader', joinedAt: new Date() },
          { session },
        );
        await db.collection('teams').insertOne(team, { session });
        // Asking to join other teams is moot once you lead your own.
        await cancelUserRequests(db, session, hackathonId, userId);
        await audit(db, session, {
          action: 'TEAM_CREATED',
          hackathonId,
          teamId: team._id,
          targetUserId: userId,
          summary: { name: team.name },
        });
      });
      return team;
    } catch (err) {
      if (isInviteCodeCollision(err)) continue; // astronomically rare: draw a new code
      if (isDuplicateKey(err)) throw httpError(409, 'ALREADY_IN_TEAM');
      throw err;
    }
  }
  throw new Error('could not generate a unique invite code');
}

// Claims a seat on the team matching `filter` and adds the member, inside the caller's
// transaction. The filter and the decrement are ONE atomic operation: if nothing matches
// (team full, code expired, wrong code) we get null and the caller decides what to report.
async function addMember(db, session, { filter, userId }) {
  const team = await db.collection('teams').findOneAndUpdate(
    filter,
    { $inc: { memberCount: 1, openSeats: -1, version: 1 } },
    { returnDocument: 'after', session },
  );
  if (!team) return null;
  // The unique (hackathonId, userId) index rejects a second team for this person; the
  // transaction then aborts and the seat claim above is rolled back.
  await db.collection('memberships').insertOne(
    { hackathonId: team.hackathonId, teamId: team._id, userId, role: 'member', joinedAt: new Date() },
    { session },
  );
  // Joining a team voids the person's other pending join requests.
  await cancelUserRequests(db, session, team.hackathonId, userId);
  await audit(db, session, {
    action: 'MEMBER_JOINED',
    hackathonId: team.hackathonId,
    teamId: team._id,
    targetUserId: userId,
    summary: { via: 'invite_code' },
  });
  return team;
}

export async function joinByCode(db, client, { hackathonId, code, userId }) {
  const normalized = normalizeCode(code);
  if (!isValidCode(normalized)) throw httpError(400, 'INVALID_CODE');
  const now = new Date();
  try {
    return await runTransaction(client, async (session) => {
      const team = await addMember(db, session, {
        filter: { hackathonId, inviteCode: normalized, inviteExpiresAt: { $gt: now }, openSeats: { $gt: 0 } },
        userId,
      });
      if (!team) {
        const found = await db
          .collection('teams')
          .findOne({ hackathonId, inviteCode: normalized }, { session, projection: { inviteExpiresAt: 1 } });
        if (!found) throw httpError(404, 'INVALID_CODE');
        if (found.inviteExpiresAt <= now) throw httpError(410, 'CODE_EXPIRED');
        throw httpError(409, 'TEAM_FULL');
      }
      return { teamId: String(team._id), userId };
    });
  } catch (err) {
    if (isMembershipDuplicate(err)) throw httpError(409, 'ALREADY_IN_TEAM');
    throw err;
  }
}

export async function getInvite(db, { teamId, actorId }) {
  const _id = toId(teamId);
  const team = await db
    .collection('teams')
    .findOne({ _id, leaderId: actorId }, { projection: { inviteCode: 1, inviteExpiresAt: 1 } });
  if (!team) {
    const exists = await db.collection('teams').findOne({ _id }, { projection: { _id: 1 } });
    throw httpError(exists ? 403 : 404, exists ? 'NOT_LEADER' : 'NOT_FOUND');
  }
  return { inviteCode: team.inviteCode, inviteExpiresAt: team.inviteExpiresAt };
}

export async function regenerateInvite(db, client, { teamId, actorId }) {
  const _id = toId(teamId);
  const current = await db.collection('teams').findOne({ _id }, { projection: { hackathonId: 1 } });
  if (!current) throw httpError(404, 'NOT_FOUND');
  const hack = await db.collection('hackathons').findOne({ _id: current.hackathonId });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await runTransaction(client, async (session) => {
        // The leader check and the new code are written together, with the audit entry.
        const team = await db.collection('teams').findOneAndUpdate(
          { _id, leaderId: actorId },
          { $set: { inviteCode: newInviteCode(), inviteExpiresAt: inviteExpiry(hack) }, $inc: { version: 1 } },
          { returnDocument: 'after', session },
        );
        if (!team) {
          const exists = await db.collection('teams').findOne({ _id }, { session, projection: { _id: 1 } });
          throw httpError(exists ? 403 : 404, exists ? 'NOT_LEADER' : 'NOT_FOUND');
        }
        await audit(db, session, {
          action: 'INVITE_REGENERATED',
          hackathonId: team.hackathonId,
          teamId: _id,
        });
        return { inviteCode: team.inviteCode, inviteExpiresAt: team.inviteExpiresAt };
      });
    } catch (err) {
      if (isInviteCodeCollision(err)) continue;
      throw err;
    }
  }
  throw new Error('could not generate a unique invite code');
}

export async function getBoard(db, { hackathonId, limit = 20 }) {
  const teams = await db
    .collection('teams')
    .find({ hackathonId, lookingForTeammates: true, openSeats: { $gt: 0 } }, { projection: PUBLIC_TEAM })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
  return { teams };
}

export async function getTeam(db, { teamId }) {
  const team = await db.collection('teams').findOne({ _id: toId(teamId) }, { projection: PUBLIC_TEAM });
  if (!team) throw httpError(404, 'NOT_FOUND');
  return team;
}

export async function leaveTeam(db, client, { teamId, userId }) {
  const _id = toId(teamId);
  return runTransaction(client, async (session) => {
    const left = await db.collection('memberships').findOneAndDelete({ teamId: _id, userId }, { session });
    if (!left) {
      const exists = await db.collection('teams').findOne({ _id }, { session, projection: { _id: 1 } });
      throw httpError(404, exists ? 'NOT_MEMBER' : 'NOT_FOUND');
    }

    // Every change to a team goes through its one document, so concurrent joins,
    // leaves and removals on the same team are serialized by the database.
    const team = await db.collection('teams').findOneAndUpdate(
      { _id },
      { $inc: { memberCount: -1, openSeats: 1, version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!team) throw new Error(`membership without a team: ${teamId}`);
    await audit(db, session, {
      action: 'MEMBER_LEFT',
      hackathonId: team.hackathonId,
      teamId: _id,
      targetUserId: userId,
    });

    if (team.memberCount === 0) {
      await db.collection('teams').deleteOne({ _id }, { session });
      // Nobody can accept a deleted team's pending requests.
      await cancelTeamRequests(db, session, _id);
      await audit(db, session, { action: 'TEAM_DELETED', hackathonId: team.hackathonId, teamId: _id });
      return { teamId, userId, teamDeleted: true };
    }

    if (team.leaderId === userId) {
      // Leader succession: the remaining member who joined earliest.
      const next = await db
        .collection('memberships')
        .find({ teamId: _id }, { session })
        .sort({ joinedAt: 1, _id: 1 })
        .limit(1)
        .next();
      await db
        .collection('teams')
        .updateOne({ _id }, { $set: { leaderId: next.userId, leaderName: await displayNameOf(db, next.userId, session) } }, { session });
      await db.collection('memberships').updateOne({ _id: next._id }, { $set: { role: 'leader' } }, { session });
      await audit(db, session, {
        action: 'LEADER_CHANGED',
        hackathonId: team.hackathonId,
        teamId: _id,
        targetUserId: next.userId,
        summary: { from: userId },
      });
      return { teamId, userId, teamDeleted: false, newLeaderId: next.userId };
    }

    return { teamId, userId, teamDeleted: false };
  });
}

export async function removeMember(db, client, { teamId, actorId, targetUserId }) {
  const _id = toId(teamId);
  if (actorId === targetUserId) throw httpError(400, 'USE_LEAVE');
  return runTransaction(client, async (session) => {
    // The leader check is part of the atomic filter, so a leadership change that
    // happens mid-flight cannot be bypassed.
    const team = await db.collection('teams').findOneAndUpdate(
      { _id, leaderId: actorId },
      { $inc: { memberCount: -1, openSeats: 1, version: 1 } },
      { returnDocument: 'after', session },
    );
    if (!team) {
      const exists = await db.collection('teams').findOne({ _id }, { session, projection: { _id: 1 } });
      throw httpError(exists ? 403 : 404, exists ? 'NOT_LEADER' : 'NOT_FOUND');
    }
    const removed = await db
      .collection('memberships')
      .findOneAndDelete({ teamId: _id, userId: targetUserId }, { session });
    // Not a member: abort, which rolls back the decrement above.
    if (!removed) throw httpError(404, 'NOT_MEMBER');
    await audit(db, session, {
      action: 'MEMBER_REMOVED',
      hackathonId: team.hackathonId,
      teamId: _id,
      targetUserId,
    });
    return { teamId, removed: targetUserId };
  });
}

// "My team" for the UI: the caller's team, their role, the members with names and, for the
// leader only, the invite code and the pending join requests. Two plain reads, not a
// transaction: a change between them gives a view that was true a moment ago, which is fine
// for a screen that refreshes on every board event.
export async function getMyTeam(db, { hackathonId, userId }) {
  const membership = await db.collection('memberships').findOne({ hackathonId, userId });
  if (!membership) return { team: null };
  const isLeader = membership.role === 'leader';
  const team = await db
    .collection('teams')
    .findOne({ _id: membership.teamId }, { projection: isLeader ? {} : PUBLIC_TEAM });
  if (!team) return { team: null };

  const rows = await db
    .collection('memberships')
    .find({ teamId: team._id })
    .sort({ joinedAt: 1, _id: 1 })
    .limit(50)
    .toArray();
  const requests = isLeader
    ? await db
        .collection('joinRequests')
        .find({ teamId: team._id, status: 'pending' })
        .sort({ createdAt: 1, _id: 1 })
        .limit(100)
        .toArray()
    : [];

  const ids = [...new Set([...rows.map((r) => r.userId), ...requests.map((r) => r.userId)])];
  const users = await db
    .collection('users')
    .find({ _id: { $in: ids } }, { projection: { displayName: 1 } })
    .toArray();
  const nameOf = new Map(users.map((u) => [u._id, u.displayName]));
  const name = (id) => nameOf.get(id) ?? id;

  return {
    team,
    role: membership.role,
    members: rows.map((r) => ({ userId: r.userId, displayName: name(r.userId), role: r.role, joinedAt: r.joinedAt })),
    requests: requests.map((r) => ({ _id: r._id, userId: r.userId, displayName: name(r.userId), createdAt: r.createdAt })),
  };
}
