import { httpError } from './errors.js';
import { toId } from './teams.js';
import { teamProfile, rankCandidates, METHOD } from './suggestions.js';

// What other people may see about a person. Never the email or anything about the account.
const PUBLIC_PERSON = { displayName: 1, skills: 1, utcOffsetMinutes: 1 };
const POOL = 500; // how many candidates are scored per suggestion request

// People who are in no team of this hackathon, newest registrations first (seeded users, which
// have no creation time, come after them, by id). The lookup uses the (hackathonId, userId)
// index, and the stream stops as soon as `limit` free people are found.
// `hackathonId` goes in through $literal because it comes from the URL.
function freeUsers(db, { hackathonId, match, limit }) {
  const pipeline = [];
  if (match) pipeline.push({ $match: match });
  pipeline.push(
    { $sort: { createdAt: -1, _id: -1 } },
    {
      $lookup: {
        from: 'memberships',
        let: { uid: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [{ $eq: ['$hackathonId', { $literal: hackathonId }] }, { $eq: ['$userId', '$$uid'] }] } } },
          { $limit: 1 },
          { $project: { _id: 1 } },
        ],
        as: 'inTeam',
      },
    },
    { $match: { inTeam: { $size: 0 } } },
    { $limit: limit },
    { $project: PUBLIC_PERSON },
  );
  return db.collection('users').aggregate(pipeline).toArray();
}

// The "people looking for a team" half of the board.
export async function getPeople(db, { hackathonId, limit = 20 }) {
  return { people: await freeUsers(db, { hackathonId, limit }) };
}

// Ranks free people for a team the caller belongs to. Only the first POOL candidates are
// scored: those who bring at least one skill the team lacks, topped up with anyone else free
// when there are too few. A bounded pool keeps the request cheap; the cost is that the best
// possible match could sit outside it (DECISIONS D27).
export async function getSuggestions(db, { teamId, actorId, limit }) {
  const n = Math.min(Math.max(Number.parseInt(limit, 10) || 10, 1), 20);
  const _id = toId(teamId);
  const team = await db.collection('teams').findOne({ _id }, { projection: { hackathonId: 1, name: 1 } });
  if (!team) throw httpError(404, 'NOT_FOUND');

  const rows = await db.collection('memberships').find({ teamId: _id }).toArray();
  if (!rows.some((r) => r.userId === actorId)) throw httpError(403, 'NOT_MEMBER');

  const members = await db
    .collection('users')
    .find({ _id: { $in: rows.map((r) => r.userId) } }, { projection: { skills: 1, utcOffsetMinutes: 1 } })
    .toArray();
  const profile = teamProfile(members);

  const { hackathonId } = team;
  let candidates = await freeUsers(db, {
    hackathonId,
    match: { skills: { $elemMatch: { $nin: profile.skills } } },
    limit: POOL,
  });
  if (candidates.length < n) {
    const seen = new Set(candidates.map((c) => c._id));
    const more = await freeUsers(db, { hackathonId, limit: POOL });
    candidates = candidates.concat(more.filter((c) => !seen.has(c._id)));
  }

  return {
    teamId: String(_id),
    team: profile,
    method: METHOD,
    considered: candidates.length,
    suggestions: rankCandidates(profile, candidates, n),
  };
}
