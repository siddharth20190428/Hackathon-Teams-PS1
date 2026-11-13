import { currentContext } from './context.js';

// Writes one audit entry inside the caller's transaction, so a change and its log entry
// commit together or not at all. Never put secrets (invite codes) in `summary`.
export function audit(db, session, entry) {
  const ctx = currentContext() ?? {};
  return db.collection('auditLog').insertOne(
    {
      ts: new Date(),
      actorId: ctx.actorId ?? null,
      requestId: ctx.requestId ?? null,
      ...entry,
    },
    { session },
  );
}
