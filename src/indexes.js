const ignoreExists = (err) => {
  if (err?.code !== 48) throw err; // 48 = NamespaceExists
};

// Indexes the correctness rules depend on. Safe to run on every start.
export async function ensureCoreIndexes(db) {
  // Create collections up front so transactions never have to create them implicitly.
  for (const name of ['hackathons', 'users', 'teams', 'memberships', 'joinRequests', 'idempotencyKeys', 'auditLog']) {
    await db.createCollection(name).catch(ignoreExists);
  }
  // One account per email: the database decides when two registrations race.
  await db.collection('users').createIndex({ email: 1 }, { unique: true });

  // One team per person per hackathon: the database enforces it.
  await db.collection('memberships').createIndex({ hackathonId: 1, userId: 1 }, { unique: true });
  await db.collection('memberships').createIndex({ teamId: 1, joinedAt: 1 });

  // Idempotency keys are scoped to the person who sent them; old ones expire after a day.
  await db.collection('idempotencyKeys').createIndex({ userId: 1, key: 1 }, { unique: true });
  await db.collection('idempotencyKeys').createIndex({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });

  // The audit log is read per team, newest first.
  await db.collection('auditLog').createIndex({ teamId: 1, ts: -1, _id: -1 });

  // At most one pending request per person per team. Decided requests do not count,
  // so a declined person may ask again.
  await db.collection('joinRequests').createIndex(
    { teamId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { status: 'pending' } },
  );
  await db.collection('joinRequests').createIndex({ teamId: 1, status: 1, createdAt: 1 });
  await db.collection('joinRequests').createIndex({ hackathonId: 1, userId: 1, status: 1 });

  // Invite codes are unique across teams. Partial, so documents without a code are fine.
  await db.collection('teams').createIndex(
    { inviteCode: 1 },
    { unique: true, partialFilterExpression: { inviteCode: { $type: 'string' } } },
  );

  // Board read path: only open teams, newest first. A partial index keeps it small
  // and matches the board query's filter and sort exactly.
  await db.collection('teams').createIndex(
    { hackathonId: 1, createdAt: -1, _id: -1 },
    {
      name: 'board_open_teams',
      partialFilterExpression: { lookingForTeammates: true, openSeats: { $gt: 0 } },
    },
  );
}
