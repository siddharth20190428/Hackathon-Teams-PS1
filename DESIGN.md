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
| `joinRequests` | `hackathonId`, `teamId`, `userId`, `status` (pending, accepted, declined, cancelled), `createdAt`, `decidedAt` | unique `(teamId, userId)` where status is pending; `(teamId, status, createdAt)`; `(hackathonId, userId, status)` |
| `users` | seed data only; no API yet | `_id` |

`memberCount` and `openSeats` are stored on the team and kept in step by the same atomic update, so the board never has to count rows.

| `idempotencyKeys` | `userId`, `key`, `requestHash`, `state` (processing or done), `status`, `body`, `startedAt`, `createdAt` | unique `(userId, key)`; TTL on `createdAt` (24 h) |
| `auditLog` | `ts`, `actorId`, `requestId`, `action`, `hackathonId`, `teamId`, `targetUserId`, `summary` | `(teamId, ts desc, _id desc)` |

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

### Idempotency

Every `POST` and `DELETE` carries an `Idempotency-Key`. The middleware claims the key by inserting a record under the unique `(userId, key)` index, so exactly one of many parallel duplicates runs the request. The others poll until the record is finished and then return the stored status and body, so all ten answers are identical. A key sent with a different method, path, query or body is rejected with 422, because it no longer means the same request. A server error (5xx) releases the key so a retry really runs again; a 4xx answer is a real answer and is stored. A record stuck in `processing` for 30 seconds (the server died mid-request) is taken over by the next retry. The stored response is written just before it is sent, so a crash in that window means the retry runs the operation again. That is safe because the rules underneath are idempotent in effect: the unique membership index and the atomic seat claim still allow at most one outcome.

### Audit log

Each state change writes its audit entry inside the same transaction, so a change and its log entry commit together or not at all, and a failed action leaves nothing behind. Entries record who acted (from the request context), the target user, the action, the request id (echoed to the client as `X-Request-Id`) and a small summary. Invite codes are never written to it. Team members can read their team's log; a deleted team's history stays in the database but has no endpoint.

### Join requests

Accepting a request is one transaction with four steps. (1) Claim a seat with a filter that also requires `leaderId` to be the caller, so a leadership change mid-flight cannot be bypassed and a non-leader learns nothing about the request. (2) Flip the request from pending to accepted; if it is no longer pending the transaction aborts and the seat claim rolls back. (3) Insert the membership; the unique index rejects someone who is already in a team. (4) Void the requester's other pending requests.

The races this resolves: two accepts for one free seat (one wins, the other gets `TEAM_FULL` and its request stays pending); an accept racing the requester joining another team (exactly one succeeds, because both touch the same request document); an accept racing the leader leaving (the accept either commits first, or finds a different leader and gets 403). Joining or creating a team, and deleting a team, void the relevant pending requests inside the same transaction.

A request created in the instant after its author joined a team can slip past the creation-time check (snapshot isolation allows this write skew). Accepting it fails on the unique membership index, the request is voided, and the leader gets `REQUESTER_UNAVAILABLE`.

## 5. Invariants

A checker (`src/invariants.js`) runs after every concurrency test and at the end of the seed script:

- I-1: `memberCount` equals the number of membership rows of the team.
- I-2: `openSeats` equals `maxSize - memberCount` and is never negative.
- I-3: a user has at most one membership per hackathon.
- I-4: every team has at least one member and exactly one leader membership, matching `leaderId`.
- I-5: no membership rows exist for a team that does not exist.
- I-6: no pending join request exists for a team that does not exist.
- I-7: for a team created through the API, creations plus joins minus leaves and removals in the audit log equal `memberCount`. Seeded teams have no log entries and are skipped.

## 6. Read path

The board query filters open teams in one hackathon, sorted newest first, limited to 20. A partial index on exactly that filter turned a collection scan of 2,000 documents into an index scan of 20 and raised throughput about three times (see PERFORMANCE.md). The board and the public team view exclude invite fields. The serialized board response is cached in process for 2 seconds, shared between concurrent requests and invalidated by every successful write (DECISIONS.md D20). Not built: cursor pagination.

## 7. Security as built

- Invite codes: 10 characters from a 32-symbol alphabet (50 bits from `crypto.randomBytes`), unique, expiring, regenerable, accepted case-insensitively. They never appear in the board or the public team view; only the leader can read them.
- Non-string code inputs, including `{ "$ne": null }`, are rejected before reaching the database.
- Joining by team id was removed because it bypassed invite codes.
- Leader-only actions check leadership inside the atomic filter.
- Live updates: `GET /hackathons/:hid/board/events` (SSE) sends a version-only "board changed" signal. The write path invalidates the board cache first and publishes second, so a client that re-reads after an event never receives the old body. Bursts are coalesced (100 ms), streams are capped per user and in total, and a client that stops reading is dropped. Every open page re-reads after an event, and the cache turns that into one database query. Limits: single instance (another process has its own streams), and the signal is sent for every hackathon (the app has one), not only the one that changed.
- Authentication: email and password, scrypt hashes, a stateless HMAC-signed session token (`{sub, exp}`) in an httpOnly, SameSite=Lax cookie or a Bearer header. Unknown email and wrong password give the same 401, and an unknown email still pays a hash check. CSRF: SameSite=Lax plus the required `Idempotency-Key` custom header on every write.
- Validation: zod `.strict()` schemas at the edge; bodies capped at 10 KB; operator objects such as `{"$ne":null}` never reach a query.
- Rate limits: in-memory fixed windows. Known limit: the per-email login limit lets someone lock a victim out for the window; accepted for now. Sessions cannot be revoked before they expire.

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

Real authentication, rate limits, input validation with a schema library, live updates, teammate suggestions, the UI, deployment.

## 10. With one more week

Change streams for multi-instance live updates, a shared rate-limit store, optimistic UI with rollback, tracing and metrics, a chaos suite that kills the server mid-transaction, and a spike on embedding members in the team document so the seat claim becomes a single-document update.
