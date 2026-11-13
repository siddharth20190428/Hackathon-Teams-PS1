// Join requests become moot in two situations; both run inside the caller's transaction.

// A person who joins or creates a team no longer needs their other pending requests.
export function cancelUserRequests(db, session, hackathonId, userId) {
  return db
    .collection('joinRequests')
    .updateMany(
      { hackathonId, userId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { session },
    );
}

// When a team is deleted, nobody can accept its pending requests.
export function cancelTeamRequests(db, session, teamId) {
  return db
    .collection('joinRequests')
    .updateMany(
      { teamId, status: 'pending' },
      { $set: { status: 'cancelled', decidedAt: new Date() } },
      { session },
    );
}
