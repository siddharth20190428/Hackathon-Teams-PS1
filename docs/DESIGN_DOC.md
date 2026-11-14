# Race-proof team formation: design document

Hack4Hack Crew Hiring Challenge 2026, problem statement 1.
Live: https://hackathon-teams.onrender.com · Code: https://github.com/siddharth20190428/Hackathon-Teams-PS1
This is the short version. The long form is [DESIGN.md](../DESIGN.md); every decision with its evidence is in [DECISIONS.md](../DECISIONS.md); the measurements are in [LOAD_TEST_REPORT.md](LOAD_TEST_REPORT.md).

## 1. What "correct" means

Ten thousand people form teams of at most four, at the same moment. Three promises matter:

1. When fifty people try to take the last seat, exactly one gets it and the other forty-nine get a clear `TEAM_FULL`.
2. Nobody is ever in two teams, and no team is left broken (no leader, a wrong member count, orphaned memberships). Seven invariants (I-1 to I-7, DESIGN.md section 5) state this precisely, and a checker runs after every concurrency test.
3. Retrying a request (double click, flaky network) never runs it twice.

## 2. The approach

**The team document is the serialization point.** Taking a seat is one conditional atomic update: change the team where `_id` matches and `openSeats > 0`, and decrement. The filter and the decrement cannot be separated, so at most `openSeats` callers can ever match. That update and the membership insert run in one multi-document transaction, and a unique index on `(hackathonId, userId)` makes the database itself reject a second team for the same person. Two transactions that touch the same team conflict; MongoDB aborts one, the driver retries it on fresh data, and it now sees `openSeats: 0` and fails cleanly. `memberCount` and `openSeats` are stored on the team and changed by the same atomic operation, so the board never counts rows.

Every other change to a team (leave, remove, invite regeneration, accepting a join request) goes through that same document, with the leader check inside the atomic filter, so a leadership change in the middle of a request cannot be bypassed by a stale check.

## 3. Alternatives I did not choose

| Option | Why not |
|---|---|
| Read the count, then insert if there is room | This was my first version, on purpose. The race test failed with 9 winners for 1 seat. |
| A lock per team (Redis or similar) | Another service to run and secure, lock expiry creates its own races, and the database constraint is still needed as the last line of defence. The constraint alone is enough. |
| A version field and an application-level retry loop | Works, but re-implements in several round trips what the conditional update does in one operation. |
| A queue per team inside the process | Breaks as soon as there is a second instance, and loses ordering on a crash. |
| Members embedded in the team document (single-document atomicity) | Plausible, and the unique multikey index could still enforce one team per person. Not chosen because per-person queries and the audit trail are simpler with rows. Kept as a spike for one more week. |

## 4. Key decisions and how I defend them

| Decision | Reason | Cost accepted |
|---|---|---|
| Transactions plus a unique index plus a conditional update (D3) | Three independent guards, each covering a different failure | A very hot team sees conflicts and retries |
| Idempotency by unique claim on `(userId, key)` (D4) | Exactly one of many parallel duplicates runs; the others get the stored answer; same key with a different request is 422; a 5xx releases the key | One extra write per request; a crash between work and storing the answer re-runs the operation, which is safe because the rules underneath still allow one outcome |
| Audit entry in the same transaction (D11) | A change and its log entry commit together or not at all | One extra write per change |
| Board cache with invalidate-before-respond (D20) | Turns 100 concurrent readers into one query; every write invalidates before it answers, so a read after a write never sees old data | In process, so one instance only; a TTL of 2 s bounds staleness |
| Live updates as a signal, not data (D24) | One read path to keep correct; events are published after the cache is invalidated, so a client that re-reads never gets the old board | Every open page re-reads after an event (absorbed by the cache) |
| Stateless signed session token, scrypt passwords (D6) | No session lookup per request; no extra dependency | A token cannot be revoked before it expires (7 days) |
| One instance, on purpose (D25) | The cache, the event streams and the rate limits are in process memory | Cannot scale out without change streams and a shared rate-limit store |
| A plain page with no framework (D26) | No build step in the deploy, four screens, easy to explain; user text only enters as text nodes and a Content-Security-Policy blocks foreign scripts | Rendering is by hand |

## 5. Evidence that it is correct

- 105 automated tests in 14 files, all passing. The core ones call the real API against a real replica set: T1 (50 users, one seat, repeated), T2 (one user joins 20 teams at once and ends in exactly one), T18 (the last member leaves while someone joins), T19 (two accepts for one seat), accept-versus-leader-leaves, and the idempotency races (ten parallel requests with one key run once).
- The invariant checker runs after every concurrency test and at the end of seeding.
- During the write-path load tests, 100 users joined and created teams at once, half of the joins aimed at five teams with one open seat each. After each of five runs, all invariants held and no contested team took more joiners than it had seats; in the two runs whose per-team output I kept, each contested team ended with exactly one new member. A script (`scripts/verify-load.js`) does this check.
- The failing first version is in the git history (tag v0), so the improvement is visible and not just claimed.

## 6. Performance in one paragraph

Target: p95 under 200 ms with 100 concurrent users. The board read went from 612 to 710 ms (no index) to 150 to 194 ms (partial index) to 39 to 42 ms (cache), and 44 to 47 ms after authentication was added. With realistic pauses between actions, 100 users on the mixed workload got p95 of 6.6 ms (board), 73.5 ms (join) and 99.5 ms (create). When the same 100 users never pause, the write path saturates at about 150 writes per second on the two shared cores and misses the target (join 707 ms, create 860 ms); I report that as a stress result. Everything was measured on one two-core machine shared by the server, the database and the load generator. Details and every run: [LOAD_TEST_REPORT.md](LOAD_TEST_REPORT.md).

## 7. Known limits

- One instance only (cache, live streams and rate limits are in memory). The upgrade path is change streams and a shared store.
- Sessions cannot be revoked early, and the per-account login limit lets someone lock out a victim for 15 minutes.
- The deployed site is on free tiers: it sleeps when idle (30 to 60 s to wake), and Atlas M0 caps operations at about 100 per second, so the deployment is smoke-tested, not load-tested.
- Write p99 is about 260 to 270 ms in the realistic profile; I have not found the cause.
- Not built: teammate suggestions (cut for time, D12), board pagination (the board shows the 20 newest teams), a chaos test that kills the server mid-transaction, an automated browser test.

## 8. How it was built

Naive first, then one measured change per iteration, each a git tag (v0 to v13) with its result in [ITERATIONS.md](ITERATIONS.md). I wrote predictions down before measuring, and the wrong ones are kept: I expected the index alone not to reach 200 ms (it did), expected the baseline board to pass (it did not), expected authentication to cost nothing (about 7 ms), and expected write p95 of 30 to 150 ms at 100 users with no pauses (it was about 5 times worse). AI tools were used throughout; every line has to be explainable (D16).

## 9. With one more week

Change streams for multi-instance cache and live updates; server-side sessions; the embedded-members spike; teammate suggestions; a chaos suite; running the load generator and the database on separate machines.
