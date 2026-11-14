# Race-proof team formation: design document

Hack4Hack Crew Hiring Challenge 2026, PS1. Live: https://hackathon-teams.onrender.com · Code: https://github.com/siddharth20190428/Hackathon-Teams-PS1
Longer forms: [DESIGN.md](../DESIGN.md), [DECISIONS.md](../DECISIONS.md) (every decision with evidence), [LOAD_TEST_REPORT.md](LOAD_TEST_REPORT.md).

## Data model (MongoDB, one replica set)

| Collection | Holds | What the database enforces |
|---|---|---|
| `teams` | name, `leaderId`, `maxSize`, `memberCount`, `openSeats`, `inviteCode` + expiry, `locked`, `version` | `memberCount` and `openSeats` change only in the same atomic update that takes or frees a seat |
| `memberships` | one row per person: `hackathonId`, `teamId`, `userId`, `role` | **unique `(hackathonId, userId)`**: nobody is in two teams |
| `joinRequests` | `teamId`, `userId`, `status` | unique pending request per person per team |
| `idempotencyKeys` | `(userId, key)`, request hash, stored response | unique `(userId, key)`; expires after a day |
| `auditLog` | who did what to which team, written in the same transaction as the change | none needed: it commits with the change |
| `users`, `hackathons` | accounts (unique email), min/max team size | |

Team status (forming, ready, locked) is computed on read from `memberCount` and the hackathon's minimum, never stored.

## How races are prevented

**The team document is the serialization point.** Taking a seat is one conditional atomic update: match `_id` and `openSeats > 0` (and not locked, code not expired), then decrement. Filter and decrement cannot be separated, so at most `openSeats` callers can match. That update and the membership insert run in one transaction. Concurrent transactions on one team conflict, MongoDB aborts one, the driver retries it on fresh data, and it now sees no seat and fails with a clean `TEAM_FULL`. Leave, remove, lock, accept and invite changes go through the same document with the leader check inside the filter, so a stale check cannot be bypassed.

Three independent guards (conditional update, transaction, unique index) each cover a different failure. Retries are safe because of idempotency keys: the first request with a key runs, parallel duplicates wait and get the stored answer, the same key with a different request is a 422. Nine invariants (`src/invariants.js`) state the rules, and the checker runs after every concurrency test, after seeding, after the load runs and after the chaos test.

**Evidence:** 163 tests on a real replica set, including 50 users racing for one seat (repeated), one user joining 20 teams at once, accept racing leave, lock racing join; a chaos test that SIGKILLs the server mid-join and verifies; all in CI. The failing first version is tag v0 (9 winners for 1 seat).

## Trade-offs I chose

| Choice | Why | Cost |
|---|---|---|
| Counts stored on the team, rows in `memberships` | Board reads never count rows; the unique index handles "one team" | Count and rows must move together (invariant I-1) |
| Transactions, not a lock service | No extra service; the database constraint is needed anyway | A very hot team sees conflict retries |
| Board cache (2 s, invalidated before every write answers) plus live updates as a signal, not data | 100 readers become one query; one read path to keep correct | In process memory, so **one instance only** |
| Stateless signed sessions | No lookup per request | Tokens cannot be revoked early (7 days) |
| React app served by the same server | One deploy, no CORS | Build step in the deploy |

## What does not work yet, stated plainly

- **Live p95 is not reliably under 200 ms.** Locally the board is 44 to 47 ms p95 at 100 users. On the free-tier URL, three identical runs gave 247, 196 and 344 ms: run-to-run noise on a shared host and public network is larger than the gap to the target, so I do not claim a pass there.
- **A hard crash stalls joins on contended teams for 30 to 90 s** (the 30 s idempotency abandoned-key window, plus MongoDB holding the dead process's open transactions). Nothing is lost or double-seated.
- **A join can commit but be reported as a conflict.** In the chaos test 9 of 32 joins in flight at the kill committed, and the retry said `ALREADY_IN_TEAM`. The idempotency response is stored outside the join transaction.
- One instance only; no pagination (board shows the newest 20 teams); free-tier site sleeps when idle.

## With one more week

1. Write the idempotency record inside the join transaction, so a retry always replays the real answer (fixes the committed-but-conflict case and the 30 s window).
2. Change streams plus a shared cache and rate-limit store, so the app can run on several instances.
3. Board pagination, and the History panel reading live instead of on change.
4. Run the load generator and database on separate machines, and a paid-tier instance, to get a live p95 that means something.
