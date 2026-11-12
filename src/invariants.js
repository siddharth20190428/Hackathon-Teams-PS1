export async function checkInvariants(db) {
  const problems = [];

  const counts = new Map(
    (
      await db
        .collection('memberships')
        .aggregate([{ $group: { _id: '$teamId', n: { $sum: 1 } } }])
        .toArray()
    ).map((r) => [String(r._id), r.n]),
  );

  for await (const t of db.collection('teams').find({})) {
    const n = counts.get(String(t._id)) ?? 0;
    if (t.memberCount !== n) {
      problems.push(`I-1 team ${t._id}: memberCount=${t.memberCount}, memberships=${n}`);
    }
    if (t.openSeats !== t.maxSize - t.memberCount || t.openSeats < 0) {
      problems.push(
        `I-2 team ${t._id}: openSeats=${t.openSeats}, max=${t.maxSize}, count=${t.memberCount}`,
      );
    }
  }

  const dupes = await db
    .collection('memberships')
    .aggregate([
      { $group: { _id: { h: '$hackathonId', u: '$userId' }, n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
      { $limit: 5 },
    ])
    .toArray();
  for (const d of dupes) {
    problems.push(`I-3 user ${d._id.u} has ${d._id.n ?? d.n} memberships in ${d._id.h}`);
  }

  return problems; // I-4 (one leader per team) is added in I2
}
