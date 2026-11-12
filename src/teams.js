import { ObjectId } from 'mongodb';
import { httpError } from './errors.js';
import { runTransaction } from './tx.js';

const toId = (s) => {
  if (!ObjectId.isValid(s)) throw httpError(404, 'NOT_FOUND');
  return new ObjectId(s);
};

const isDuplicateKey = (err) => err?.code === 11000;

export async function createTeam(db, client, { hackathonId, userId, name }) {
  const hack = await db.collection('hackathons').findOne({ _id: hackathonId });
  if (!hack) throw httpError(404, 'HACKATHON_NOT_FOUND');
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'INVALID_NAME');

  const team = {
    _id: new ObjectId(),
    hackathonId,
    name: name.trim(),
    leaderId: userId,
    leaderName: userId,
    maxSize: hack.maxTeamSize,
    memberCount: 1,
    openSeats: hack.maxTeamSize - 1,
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
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw httpError(409, 'ALREADY_IN_TEAM');
    throw err;
  }
  return team;
}

export async function joinTeam(db, client, { teamId, userId }) {
  const _id = toId(teamId);
  try {
    return await runTransaction(client, async (session) => {
      // Claim the seat. The filter and the decrement are ONE atomic operation:
      // if openSeats is already 0 the filter matches nothing and we get null.
      const team = await db.collection('teams').findOneAndUpdate(
        { _id, openSeats: { $gt: 0 } },
        { $inc: { memberCount: 1, openSeats: -1, version: 1 } },
        { returnDocument: 'after', session },
      );

      if (!team) {
        const exists = await db.collection('teams').findOne({ _id }, { session, projection: { _id: 1 } });
        if (!exists) throw httpError(404, 'NOT_FOUND');
        throw httpError(409, 'TEAM_FULL');
      }

      // The unique (hackathonId, userId) index rejects a second team for this person.
      // If it does, the whole transaction aborts and the seat claim above is rolled back.
      await db.collection('memberships').insertOne(
        { hackathonId: team.hackathonId, teamId: _id, userId, role: 'member', joinedAt: new Date() },
        { session },
      );
      return { teamId, userId };
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw httpError(409, 'ALREADY_IN_TEAM');
    throw err;
  }
}

export async function getBoard(db, { hackathonId, limit = 20 }) {
  const teams = await db
    .collection('teams')
    .find({ hackathonId, lookingForTeammates: true, openSeats: { $gt: 0 } })
    .sort({ createdAt: -1, _id: -1 })
    .limit(limit)
    .toArray();
  return { teams };
}

export async function getTeam(db, { teamId }) {
  const team = await db.collection('teams').findOne({ _id: toId(teamId) });
  if (!team) throw httpError(404, 'NOT_FOUND');
  return team;
}
