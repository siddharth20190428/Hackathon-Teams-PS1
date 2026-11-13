# Testing

## Strategy

- **API tests with Vitest.** They start the real Express app on a random port and call it with `fetch`, against a real MongoDB replica set. Each test file gets its own database (`test_<random>`), dropped afterwards.
- **Race tests.** `Promise.all` bursts of concurrent requests through HTTP, each followed by the invariant checker. A race test is only trusted if it first fails against a naive implementation. The first version of the join (v0) failed T1 with 9 winners for 1 seat; the current one passes.
- **Invariant checker.** `src/invariants.js` verifies the rules listed in DESIGN.md section 5. It runs after concurrency tests and at the end of the seed script.
- **Load tests with k6.** See PERFORMANCE.md.

## Running

Start the MongoDB container first (see README.md).

```
npm test                              # all suites
RACE_ROUNDS=20 npm run test:race      # the 50-way race, 20 rounds
npm run seed                          # also runs the invariant checker on 10,000 users
```

If every suite fails with a hook timeout after about 30 seconds, MongoDB is not reachable. Run `docker ps -a --filter name=mongo` and `docker start mongo`.

## What is covered

26 tests in 4 files.

| File | Tests |
|---|---|
| `test/race.test.js` | T1: 50 users race for the last seat; repeated 5 rounds by default, 20 with `RACE_ROUNDS=20` |
| `test/join.test.js` | T2: one user joins 20 teams at once and ends up in exactly one. T4 (partly): parallel create-team by one user makes one team and no orphan. T7: a full team returns `TEAM_FULL` and changes nothing |
| `test/leave.test.js` | T16 leader succession. T17 last member deletes the team and frees the person. Non-member leave. T12 non-leader cannot remove. Leader removes a member, who can then join elsewhere. Leader cannot remove self. Removing a non-member rolls the count back. T18 last member leaves while someone joins (20 rounds). Two members leave at once (10 rounds). Removing a member while they leave (10 rounds) |
| `test/invite.test.js` | Code format and uniqueness (2,000 codes). Normalization. Default 48 h expiry. Correct code in any case. T9 wrong and malformed codes, including operator-injection payloads. T8 expired code. Full team. Already in a team. Direct join by id is gone. Codes never appear on the board or team view. Only the leader can read or regenerate the code. Regeneration invalidates the old code |

## Not covered yet

Idempotency replay (T3, T5, T6), rate limiting (T10), join requests (T11, T13 to T15, T19), authentication (T21), audit log (T22), board pagination (T23), suggestions (T24), live updates (T25), and the chaos test (T26).

## Known limits of these tests

- They run on a single-node replica set, so write latency is lower than on a multi-node cluster.
- Server and test client share one process and one machine.
- Race tests increase confidence but cannot prove the absence of every interleaving; the design (DESIGN.md section 4) is what makes the guarantee, and the tests are the evidence.

## CI

`.github/workflows/ci.yml` starts the same replica set with Docker, runs `npm test`, runs the race test for 20 rounds, and seeds the database to check invariants. Confirm the first run is green before relying on it.
