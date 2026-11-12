// Runs fn(session) inside a MongoDB transaction.
// The driver retries the whole callback when MongoDB reports a transient error
// (for example a write conflict with another transaction), so fn must be safe to re-run.
export async function runTransaction(client, fn) {
  const session = client.startSession();
  let result;
  try {
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      {
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
        readPreference: 'primary',
      },
    );
    return result;
  } finally {
    await session.endSession();
  }
}
