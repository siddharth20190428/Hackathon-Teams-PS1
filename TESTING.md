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

162 tests in 19 files.

| File | Tests |
|---|---|
| `test/race.test.js` | T1: 50 users race for the last seat; repeated 5 rounds by default, 20 with `RACE_ROUNDS=20` |
| `test/join.test.js` | T2: one user joins 20 teams at once and ends up in exactly one. T4 (partly): parallel create-team by one user makes one team and no orphan. T7: a full team returns `TEAM_FULL` and changes nothing |
| `test/compression.test.js` | Board and people: gzip only when accepted, plain otherwise, `Vary`; the compressed body decodes to the plain one; stable weak ETag; 304 with no body in both encodings; a write changes the ETag. |
| `test/validation.test.js` | Join code (every non-string, wrong shape, extra fields, length); `?limit` (nonsense, repeated, out of range, bounds); malformed team, request, user and hackathon ids on every route that takes them; unknown hackathon; wrong-typed and unknown body fields on register, login and create team; malformed and non-object JSON; 413. |
| `test/profile.test.js` | Profile edit: field rules, protected fields, idempotent replay, rename reaches the board, skills reach suggestions. |
| `test/minsize.test.js` | forming, ready and locked; lock refused below the minimum; locked teams refuse code, request and accept; auto-unlock below the minimum; lock racing 10 joins, the second member leaving and 6 join requests; the checker catches I-8 and I-9. |
| `test/leave.test.js` | T16 leader succession. T17 last member deletes the team and frees the person. Non-member leave. T12 non-leader cannot remove. Leader removes a member, who can then join elsewhere. Leader cannot remove self. Removing a non-member rolls the count back. T18 last member leaves while someone joins (20 rounds). Two members leave at once (10 rounds). Removing a member while they leave (10 rounds) |
| `test/invite.test.js` | Code format and uniqueness (2,000 codes). Normalization. Default 48 h expiry. Correct code in any case. T9 wrong and malformed codes, including operator-injection payloads. T8 expired code. Full team. Already in a team. Direct join by id is gone. Codes never appear on the board or team view. Only the leader can read or regenerate the code. Regeneration invalidates the old code |
| `test/boardCache.test.js` | Unit tests, no database: concurrent misses share one load; TTL expiry with a fake clock; invalidation drops values; a load running during an invalidation is not stored; errors are not cached; TTL 0 disables the cache; the entry cap evicts |
| `test/board.test.js` | A new team is on the board immediately after creation, even after a cached read; a team leaves the board when it fills and returns when someone leaves; a deleted team disappears at once |
| `test/requests.test.js` | T13 request, list, accept. T14 decline, then ask again. T11 non-leaders cannot list, accept or decline. Cancel by the requester only. Duplicate, own-team and full-team guards. T15 request voided when the requester joins elsewhere first, and a stale pending request voided cleanly. Joining or creating a team voids other requests. T17 last member leaving cancels pending requests. T19 two accepts for one seat (10 rounds). Accept racing the requester joining elsewhere (10 rounds). Accept racing the leader leaving (10 rounds) |
| `test/idempotency.test.js` | Request hashing ignores key order. Missing and malformed keys rejected; reads need none. T5 replay returns the identical stored response. T6 same key with a different request is 422. T3 ten parallel requests with one key run once (AC-3). T3b ten parallel joins with one key. T4 double-clicked create-team. Keys are scoped per user. A stored failure is replayed after the situation changes. A stale `processing` record is taken over. The stored record shape |
| `test/audit.test.js` | T22 every change has an entry with actor, target and request id. Join-request decisions. Leader succession and departure. A failed action leaves no entry. A deleted team keeps its history. Members only, and no invite codes in the log. I-7 detects a tampered member count |
| `test/auth.test.js` | Register and login, cookie flags, hashed password at rest. Ten racing registrations of one email (case-insensitive) make one account. Wrong password and unknown email look identical. T21 every protected route is 401 without a session; the old `x-user-id` header no longer works. Tampered, expired and garbage tokens are rejected. T20 operator-injection and malformed bodies, invalid JSON and oversized bodies. Create-team validation. End-to-end cookie session through join-by-code with actor ids in the audit log. T10 invite-code guessing is blocked per user; per-email and per-IP login limits |
| `test/tokens.test.js` | Unit tests, no database: token round trip, tampering, expiry with a fake clock, short secret refused; scrypt salt and verification |
| `test/rateLimit.test.js` | Unit tests, no database: window limits with a fake clock, per-key counting, bounded key count, 429 with `Retry-After` |
| `test/events.test.js` | Hub unit tests, no database: a burst of publishes becomes one event with the latest version; total and per-user stream caps and freeing a slot on close; a client that is not reading is dropped. T25 over HTTP: 401 without a session; the stream opens with a `ready` event; a new team wakes the stream and the board read right after shows it; 15 parallel creates send fewer events than writes, versions never go backwards, and the board then shows all 15; a failed write sends no event; the per-user cap returns 429 and frees on close |
| `test/myteam.test.js` | Needs a session. Empty for someone with no team. The leader sees the team, named members, the invite code and pending requests. A member sees the team without the invite code or requests (the code appears nowhere in the response). The view follows leaving and leader succession. The page is served at `/` with the security headers, the API stays behind the session, unknown paths are 401 for anonymous callers and a JSON 404 when signed in |
| `test/suggestions.test.js` | Scoring unit tests, no database: weights sum to 1, clock distance wraps around midnight, median offset, team profile, perfect and repeated skills, half new skills, time-zone share falls to 0 at 8 hours, a candidate with no skills, ranking with deterministic tie-breaks and a limit. T24 over HTTP: free people ranked by skills and time zone with the reasons; people in a team and the team's own members are left out; no email or password hash in any response; only team members can ask (403), 404 for unknown teams, 401 without a session; the limit parameter; the people list is free people only, newest first; a person who joins leaves the list at once and the team's changed skills change the ranking; a new account appears in the list at once |

## Web page check

The page itself has no automated test in the repository. It was checked by hand in a real browser (Chromium, driven by a script) against a stub API with the same response shapes: sign-up validation message, live board growth after another user's action, wrong invite code, create team, leader view, accept a request, new invite code, two-click leave, sign out and a bad sign-in, on desktop and phone widths, with a name containing HTML to confirm it is shown as text. No script errors and no Content-Security-Policy violations. It was then clicked through by hand against the running server and the deployed site.

## Deployment smoke test

`scripts/smoke.js` runs the user journey over a public URL: wake the service, register, session cookie on `/me`, 401 without a session, live stream opens and delivers an event after a write (proves the proxy does not buffer it), create team, join by invite code, wrong code refused, team on the board, audit log with both actors, bad login refused. Run: `BASE_URL=https://... node scripts/smoke.js`. It passes against https://hackathon-teams.onrender.com .

## Load-time correctness check

`scripts/verify-load.js` runs after `load/mixed.js`: it runs the invariant checker (I-1 to I-9) over the whole database, and checks for each hot team that member count equals membership rows, open seats are not negative, and joiners did not exceed the seats it had. This is the check that speed did not cost correctness.

## Not covered yet

Board pagination (T23) and the chaos test (T26). Live updates were tested through the HTTP stream only; no browser client has been run against them yet.

## Known limits of these tests

- They run on a single-node replica set, so write latency is lower than on a multi-node cluster.
- Server and test client share one process and one machine.
- Race tests increase confidence but cannot prove the absence of every interleaving; the design (DESIGN.md section 4) is what makes the guarantee, and the tests are the evidence.

## CI

`.github/workflows/ci.yml` starts the same replica set with Docker, runs `npm test`, runs the race test for 20 rounds, and seeds the database to check invariants. Confirm the first run is green before relying on it.

## Chaos test (`npm run chaos`)

`scripts/chaos.js` starts the real server, fires 40 concurrent joins at 3 teams with 1 to 2 open seats, kills the server with SIGKILL 15 to 135 ms in, restarts it and retries every unanswered request with the same Idempotency-Key. It then checks that every invariant holds, that no team is over capacity, and that every final answer agrees with the database (201 means a membership row exists, TEAM_FULL means it does not). It runs in CI with 2 rounds.

What it found:
- A real bug (v24): a retry of a join that had filled the team was answered TEAM_FULL although the seat was the caller's. Now ALREADY_IN_TEAM, with a regression test in `test/join.test.js`.

What it measured (local, 4 rounds, all passed):
- Recovery after a hard kill is 30 to 90 s on the contended teams: 30 s is the idempotency "abandoned key" window, the rest is MongoDB holding the dead process's open transactions until it aborts them (about 60 s).
- 9 of 32 joins in flight at the kill had committed but were answered ALREADY_IN_TEAM on retry, because the idempotency response is stored outside the join transaction. Nobody is lost or double-seated, but the person is told "conflict" for a join that worked. Fix (not done): write the idempotency record in the same transaction.

