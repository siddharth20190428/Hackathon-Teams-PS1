# Iterations: what changed, why, and what the results showed

The project was built in small patches. Each one was run against the tests, and the board was load-tested at checkpoints. Dates are 12 Nov 2026.

## v0: naive join, race test, seed, invariants (patch 0001)

**Why:** to prove the race exists before fixing it. A fix without a failing test proves nothing.
**What:** a join that reads the team, checks for a free seat, then writes, with no atomicity. A test where 50 users race for one seat. A seed script (10,000 users, 2,000 teams). An invariant checker.
**Result:** the test failed with 9 winners and 41 `TEAM_FULL` for one seat. The same bug corrupts the data: with 9 winners, `openSeats` goes to about -8 and the member count exceeds the maximum.

## Package fix (patch 0002)

**Why:** `package.json` said `"type": "commonjs"`, so every `import` failed.
**What:** switched to ES modules and added `start`, `seed`, `test` and `test:race` scripts.

## v0 baseline load test (patch 0003)

**Why:** to have a number to improve against.
**Result:** about 300 requests per second, p95 612-710 ms against a 200 ms target. With 100 users who never wait, latency is about 100 divided by throughput, so the target meant roughly 3x the throughput.

## v1: atomic seat claim (patch 0004)

**Why:** the race test was red. A single database operation had to decide who gets the last seat.
**What:** a conditional update (`openSeats > 0`), a unique index on `(hackathonId, userId)`, and a transaction around the claim, the membership insert and team creation. Added tests for one user joining 20 teams (T2), parallel team creation (T4) and joining a full team (T7).
**Result:** the same race test passed 45 rounds of 50 contenders with no failure; 20 rounds took about 4.1 s. A first test run timed out after 30 s because the Docker container had stopped, not because of the code; the lesson is to run `docker start mongo` after a restart.

## v2: partial index for the board (patch 0005)

**Why:** the baseline missed the target by about 3x, and the query scanned all 2,000 teams.
**What:** a partial index matching the board's filter and sort exactly, and a script that prints the query plan.
**Result:** `SORT > COLLSCAN` (2,000 documents) became `LIMIT > FETCH > IXSCAN` (20). Throughput rose to 800-1,000 requests per second and p95 fell to 150-194 ms. The 60-second runs showed a margin of only 3% and 11%, so the 30-second passes were optimistic.

## v3: leave, remove, leader succession (patch 0006)

**Why:** the team rules need to hold when members leave, not only when they join.
**What:** leave, remove member (leader only, leadership checked inside the atomic filter), succession to the earliest-joined member, deletion of an empty team. The invariant checker now also verifies one leader per team and no orphaned memberships. Ten tests, including three races: last member leaving while someone joins, two members leaving at once, and removing a member while they leave.
**Result:** 14 tests green. The stronger checker passes on the 10,000-user seed.

## v4: invite codes (patch 0007)

**Why:** joining by team id let anyone join any team with a free seat, bypassing the invite mechanism, and the board returned whole team documents, which would have exposed invite codes. Both were found while designing codes.
**What:** invite codes (50 bits, expiring, regenerable, case-insensitive), a join-by-code endpoint, leader-only code view and regeneration, removal of the open join route, and a projection that hides invite fields from the board and the team view. The existing tests now join through codes, so the race is still run against the real join path.
**Result:** 26 tests green. The first board smoke run measured p95 207.1 ms, above the threshold. Two repeat runs gave 195.5 and 162.1 ms, so the difference from v2 is mostly noise, but the margin had been as thin as 2%, so the board cache was moved up (DECISIONS.md D20).

## v6: board cache (patch 0009)

**Why:** after the index, p95 ranged from 150 to 207 ms across seven runs. A pass that depends on luck is not a pass, and the deployed database (Atlas M0, about 100 operations per second) could not serve the load without a cache anyway.
**What:** an in-process cache of the serialized board response with a 2 s TTL, shared between concurrent requests and invalidated before the response of every successful write. Unit tests for the cache (including a load that overlaps an invalidation) and API tests for freshness after create, join, leave and delete.
**Result:** with the cache on, p95 was 39 to 42 ms in five runs (three of 30 s, two of 60 s) at 5,000 to 5,400 requests per second. The same code with `BOARD_CACHE_TTL_MS=0` gave 145 to 159 ms at about 1,000 requests per second. So the cache cut p95 about 3.7 times and raised throughput about 5 times, and the margin against the target went from as little as 2% to about 80%. The multi-second latency outliers appeared only in the cache-off runs, which places them on the database path. Caveats: the test is read-only and hits one key, k6 and Node share the two cores at this rate, and the effect under concurrent writes is not measured yet. 36 tests green.

## v7: join requests (patch 0011)

**Why:** joining by code is only one of the two ways in; the other is asking the leader. It is also the richest source of races, because a request outlives the moment it was made.
**What:** request, list, accept, decline and cancel. Accept is one transaction (seat claim with the leader check in the filter, request decision, membership insert, voiding the requester's other requests). Joining or creating a team and deleting a team void pending requests in the same transaction. Requests, declines and cancellations do not invalidate the board cache.
**Result:** see the test run recorded after this patch was applied; 12 new tests, 48 in total.

## v8: idempotency keys and audit log (patch 0012)

**Why:** a retried request (double click, flaky network) must not run twice, and every change to a team needs a record of who made it. Both were planned requirements; the audit log also lets the invariant checker cross-check member counts (I-7).
**What:** every write requires an `Idempotency-Key`; the key is claimed with a unique insert, parallel duplicates wait for the first to finish and return the same answer, and a key reused for a different request gets 422. Each state change writes an audit entry in the same transaction. Requests carry an id (`X-Request-Id`) and the acting user through an `AsyncLocalStorage` context. New read endpoint: the team audit log.
**Result:** 66 tests green (one assertion in my own test needed a fix, patch 0013: the stored record keeps the raw ObjectId while the replayed JSON is identical). The seed passes all invariants. The board was re-measured: p95 of 38.1 to 39.3 ms over three 30 s runs, unchanged from v6, so request ids and the context cost nothing measurable on reads. Writes were not load-tested.

## Decisions outside the patches

- **Dropped `mongodb-memory-server`.** Its `mongod` binary ran but failed to start in the codespace within its timeout. Development, tests and load runs use a Docker replica set.
- **Atlas M0 is for the live site only.** It caps operations at about 100 per second, which would measure the cap instead of the code. A smoke test confirmed that transactions work on it.

## Next

Real authentication and rate limits, then live updates and the UI, then deployment.
