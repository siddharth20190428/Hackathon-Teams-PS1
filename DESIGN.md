# Design

This describes what is built today. Items that are not built yet are listed in the last two sections.

## 1. Problem

Ten thousand people form teams of a limited size at the same moment. The hard requirement is correctness under concurrency: two people must never both get the last seat, nobody may end up in two teams, and a team must never be left in a state that breaks its rules (no leader, wrong member count, orphaned memberships).

## 2. Architecture

```
Client -> Express (src/app.js, thin routes)
              |
              v
          src/teams.js  (every state change lives here)
              |
              v
          MongoDB replica set (transactions, unique indexes)
```

Route handlers only parse input and call one function in `src/teams.js`. That keeps the concurrency logic in one place.

## 3. Data model

| Collection | Fields that matter | Indexes |
|---|---|---|
| `hackathons` | `_id`, `minTeamSize`, `maxTeamSize`, `inviteTtlHours` | `_id` |
| `teams` | `hackathonId`, `name`, `leaderId`, `maxSize`, `memberCount`, `openSeats`, `inviteCode`, `inviteExpiresAt`, `lookingForTeammates`, `version`, `createdAt` | unique `inviteCode` (partial); partial board index on `(hackathonId, createdAt desc, _id desc)` for open teams |
| `memberships` | `hackathonId`, `teamId`, `userId`, `role`, `joinedAt` | unique `(hackathonId, userId)`; `(teamId, joinedAt)` |
| `users` | seed data only; no API yet | `_id` |

`memberCount` and `openSeats` are stored on the team and kept in step by the same atomic update, so the board never has to count rows.

Planned collections, not built: `joinRequests`, `idempotencyKeys`, `auditLog`.

## 4. How concurrency is handled

Four mechanisms, each covering a different failure:

1. **Conditional atomic update.** Taking a seat is one operation: update the team where `_id` matches and `openSeats > 0`, and decrement. The filter and the decrement cannot be separated, so at most `openSeats` callers can ever match.
2. **Unique index** on `(hackathonId, userId)` in `memberships`. The database itself rejects a second team for the same person, however many requests arrive together.
3. **Transaction.** The seat claim and the membership insert commit together or not at all. If the insert hits the unique index, the claim rolls back, so a seat is never lost to a request that failed.
4. **Retry on conflict.** Two transactions that change the same team document conflict, and MongoDB aborts one with a transient error. The driver re-runs it on fresh data, where it now sees `openSeats` of 0 and fails cleanly with `TEAM_FULL`.

Every change to a team (join, leave, remove, invite regeneration) goes through that team's single document. That is what serializes concurrent operations on the same team.

### Worked example: 50 users, one free seat

Fifty requests carry the correct code. All fifty start a transaction and try the conditional update. One wins. The other forty-nine hit a write conflict, retry, see `openSeats: 0`, match nothing, and return `409 TEAM_FULL`. The winner's membership insert succeeds. The final state: member count equals the maximum, membership rows equal the maximum, and the invariants hold.

### Leave, succession and deletion

Leaving deletes the membership and decrements the count in one transaction. If the count reaches 0, the team is deleted. If the leaver was the leader, leadership passes to the remaining member with the earliest `joinedAt` (ties broken by `_id`), which is deterministic and testable. A join racing the last member's leave ends one of two valid ways: the join committed first and the joiner inherits the team, or the team was deleted first and the join gets 404. The T18 test checks both outcomes for corruption.

### Authorization inside the atomic filter

Removing a member and regenerating a code match on `leaderId` inside the update filter itself, so a leadership change that lands mid-request cannot be bypassed by a stale check.

## 5. Invariants

A checker (`src/invariants.js`) runs after every concurrency test and at the end of the seed script:

- I-1: `memberCount` equals the number of membership rows of the team.
- I-2: `openSeats` equals `maxSize - memberCount` and is never negative.
- I-3: a user has at most one membership per hackathon.
- I-4: every team has at least one member and exactly one leader membership, matching `leaderId`.
- I-5: no membership rows exist for a team that does not exist.

## 6. Read path

The board query filters open teams in one hackathon, sorted newest first, limited to 20. A partial index on exactly that filter turned a collection scan of 2,000 documents into an index scan of 20 and raised throughput about three times (see PERFORMANCE.md). The board and the public team view exclude invite fields. The serialized board response is cached in process for 2 seconds, shared between concurrent requests and invalidated by every successful write (DECISIONS.md D20). Not built: cursor pagination.

## 7. Security as built

- Invite codes: 10 characters from a 32-symbol alphabet (50 bits from `crypto.randomBytes`), unique, expiring, regenerable, accepted case-insensitively. They never appear in the board or the public team view; only the leader can read them.
- Non-string code inputs, including `{ "$ne": null }`, are rejected before reaching the database.
- Joining by team id was removed because it bypassed invite codes.
- Leader-only actions check leadership inside the atomic filter.
- Not secure yet: the caller is named by a plain `x-user-id` header. It exists only so the concurrency work could be built and measured first. Real authentication replaces it before this is exposed to anyone.

## 8. Trade-offs and limits

| Choice | Cost |
|---|---|
| The team document is the serialization point | A very hot team sees conflicts and retries. Measured locally: 20 rounds of a 50-way race took about 4.1 s in total, including setup, on a single-node database |
| Counts stored on the team | Every writer must update them in the same transaction. The invariant checker exists to catch drift |
| Invite codes stored in plain text | A database leak exposes live codes. Low impact, and the leader needs to read them |
| Tests run on a single-node replica set | A multi-node cluster with majority writes will be slower |
| Free Atlas M0 caps operations at about 100 per second | The deployed site cannot serve the graded load without a cache; the p95 evidence is local |
| The board cache lives in process memory | Single instance only; if another process wrote, staleness is bounded by the 2 s TTL |

## 9. Not built yet

Join requests, real authentication, idempotency keys, audit log, rate limits, input validation with a schema library, live updates, teammate suggestions, the UI, deployment.

## 10. With one more week

Change streams for multi-instance live updates, a shared rate-limit store, optimistic UI with rollback, tracing and metrics, a chaos suite that kills the server mid-transaction, and a spike on embedding members in the team document so the seat claim becomes a single-document update.
