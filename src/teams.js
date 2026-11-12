import { ObjectId } from 'mongodb';

const httpError = (status, code) => Object.assign(new Error(code), { status, code });

const toId = (s) => {
  if (!ObjectId.isValid(s)) throw httpError(404, 'NOT_FOUND');
  return new ObjectId(s);
};

export async function createTeam(db, { hackathonId, userId, name }) {
  const hack = await db.collection('hackathons').findOne({ _id: hackathonId });
  if (!hack) throw httpError(404, 'HACKATHON_NOT_FOUND');
  if (typeof name !== 'string' || !name.trim()) throw httpError(400, 'INVALID_NAME');
  const already = await db.collection('memberships').findOne({ hackathonId, userId });
  if (already) throw httpError(409, 'ALREADY_IN_TEAM');
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
  await db.collection('teams').insertOne(team);
  await db.collection('memberships').insertOne({
    hackathonId,
    teamId: team._id,
    userId,
    role: 'leader',
    joinedAt: new Date(),
  });
  return team;
}

export async function joinTeam(db, { teamId, userId }) {
  const _id = toId(teamId);
  const team = await db.collection('teams').findOne({ _id });
  if (!team) throw httpError(404, 'NOT_FOUND');
  const already = await db
    .collection('memberships')
    .findOne({ hackathonId: team.hackathonId, userId });
  if (already) throw httpError(409, 'ALREADY_IN_TEAM');
  if (team.openSeats <= 0) throw httpError(409, 'TEAM_FULL');
  // NAIVE ON PURPOSE (I0): the checks above and the writes below are not atomic.
  await db.collection('memberships').insertOne({
    hackathonId: team.hackathonId,
    teamId: _id,
    userId,
    role: 'member',
    joinedAt: new Date(),
  });
  await db
    .collection('teams')
    .updateOne({ _id }, { $inc: { memberCount: 1, openSeats: -1, version: 1 } });
  return { teamId, userId };
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
