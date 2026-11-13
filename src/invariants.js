export async function checkInvariants(db) {
  const problems = [];
  const memberships = db.collection('memberships');

  const counts = new Map(
    (await memberships.aggregate([{ $group: { _id: '$teamId', n: { $sum: 1 } } }]).toArray()).map(
      (r) => [String(r._id), r.n],
    ),
  );

  const leaders = new Map();
  for await (const m of memberships.find({ role: 'leader' }, { projection: { teamId: 1, userId: 1 } })) {
    const key = String(m.teamId);
    leaders.set(key, [...(leaders.get(key) ?? []), m.userId]);
  }

  const teamIds = new Set();
  for await (const t of db.collection('teams').find({})) {
    const key = String(t._id);
    teamIds.add(key);
    const n = counts.get(key) ?? 0;
    if (t.memberCount !== n) {
      problems.push(`I-1 team ${key}: memberCount=${t.memberCount}, memberships=${n}`);
    }
    if (t.openSeats !== t.maxSize - t.memberCount || t.openSeats < 0) {
      problems.push(`I-2 team ${key}: openSeats=${t.openSeats}, max=${t.maxSize}, count=${t.memberCount}`);
    }
    if (t.memberCount < 1) {
      problems.push(`I-4 team ${key}: has ${t.memberCount} members but still exists`);
    }
    const l = leaders.get(key) ?? [];
    if (l.length !== 1 || l[0] !== t.leaderId) {
      problems.push(`I-4 team ${key}: leaderId=${t.leaderId}, leader memberships=${JSON.stringify(l)}`);
    }
  }

  for (const key of counts.keys()) {
    if (!teamIds.has(key)) problems.push(`I-5 memberships exist for missing team ${key}`);
  }

  // I-6: no pending join request may point at a team that does not exist.
  for await (const r of db.collection('joinRequests').find({ status: 'pending' }, { projection: { teamId: 1 } })) {
    if (!teamIds.has(String(r.teamId))) {
      problems.push(`I-6 pending join request ${r._id} for missing team ${r.teamId}`);
    }
  }

  const dupes = await memberships
    .aggregate([
      { $group: { _id: { h: '$hackathonId', u: '$userId' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();
  for (const d of dupes) {
    problems.push(`I-3 user ${d._id.u} has ${d.n} memberships in ${d._id.h}`);
  }

  return problems;
}
