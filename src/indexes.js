const ignoreExists = (err) => {
  if (err?.code !== 48) throw err; // 48 = NamespaceExists
};

// Indexes the correctness rules depend on. Safe to run on every start.
export async function ensureCoreIndexes(db) {
  // Create collections up front so transactions never have to create them implicitly.
  for (const name of ['hackathons', 'users', 'teams', 'memberships']) {
    await db.createCollection(name).catch(ignoreExists);
  }
  // One team per person per hackathon: the database enforces it.
  await db.collection('memberships').createIndex({ hackathonId: 1, userId: 1 }, { unique: true });
  await db.collection('memberships').createIndex({ teamId: 1, joinedAt: 1 });
}
