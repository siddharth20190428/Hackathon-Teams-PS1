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

## v9: authentication, rate limits, validation (patch 0015)

**Why:** every earlier result was measured with a caller-supplied header that anyone could forge, and any user could be sent unbounded invite-code guesses. Neither can be exposed publicly.
**What:** register, login, logout, `/me`; scrypt passwords; signed session token in a cookie or Bearer header; strict zod schemas; body size cap; in-memory rate limits; JSON 404 and error handler; `SESSION_SECRET` required at start. Load test now sends a minted token.
**Result:** 24 new tests, 90 green; seed invariants ok. Board re-measured with a minted token (three 30 s runs): p95 46.7, 47.2 and 44.2 ms at 4,477 to 4,692 requests per second, against 38.1 to 39.3 ms at about 5,400 to 5,570 for v8. So auth added about 7 ms of p95 (+18%) and cost about 15% of throughput, from per-request cookie parsing, an HMAC check and a JSON parse. The target is still met with about 76% margin. My prediction of no visible change was wrong. Not optimized: token memoization would add cache logic to a security path for a margin we already have. Write paths still not load-tested.

## v10: live board updates (patch 0016)

**Why:** a board that only changes on refresh hides the point of the system: when the last seat goes, everyone should see it go. It is also a requirement from the brief.
**What:** an SSE stream for the board that sends a version-only "changed" signal, published right after the cache invalidation and coalesced over 100 ms; caps of 5 streams per user and 2,000 in total; slow readers dropped. The client re-reads the cached board. Per-team events were left out on purpose.
**Result:** 9 new tests, 99 in total (3 hub unit tests, 6 over HTTP). The load cost of open streams is not measured yet. Unverified: behaviour through Render's proxy (heartbeat and `X-Accel-Buffering` are set for it).

## v11: write-path load test (patch 0017)

**Why:** every latency number so far is a cached read of one key. The brief judges concurrency correctness first, and the write paths (transactions, idempotency, audit) had only been tested for correctness, never for speed under load.
**What:** a k6 scenario mixing board reads, joins (half aimed at a few hot seats) and team creation with a fresh user per write; a fixtures script; a post-run verifier that runs all invariants; `RATE_LIMITS=off` for load runs.
**Result:** correctness held in all five runs (invariants ok, no hot team over its seats, no 5xx; in the two runs with per-team output, the 5 hot seats went to exactly 5 joiners). Performance did not meet the 200 ms target at 100 users with no pause: join p95 707 ms, create p95 860 ms, board p95 170 ms. A sweep from 10 to 100 users shows flat throughput (about 500 req/s, about 150 writes/s) and latency proportional to users: saturation of the two shared cores, not a per-request cost. At 10 users all three operations pass. My prediction (30 to 150 ms at 100 users) was wrong by about 5 times. Decision: not to optimize now; add a think-time option, measure a realistic profile against a recorded prediction, and report the stress numbers as they are. Realistic profile (100 users, 1 s mean pause, about 96 req/s): board p95 6.6 ms, join 73.5 ms, create 99.5 ms, all under the target and slightly better than my recorded prediction; invariants ok. Write p99 is about 260 to 270 ms (cause not measured). Details in PERFORMANCE.md.

## v12: deployment (patch 0020)

**Why:** a live URL is a required deliverable, and the parts most likely to fail only on a real host (cookies behind a proxy, live streams through a proxy, Atlas transactions, cold starts) cannot be seen locally.
**What:** `render.yaml` (free web service, one instance), `docs/DEPLOY.md` (Atlas, seeding, Render, cold starts, troubleshooting, rollback), `scripts/smoke.js` (the user journey over the public URL), and graceful shutdown on SIGTERM so deploys do not cut off requests or leave the live streams open.
**Result:** deployed to https://hackathon-teams.onrender.com . `scripts/smoke.js` passed against it, including the live stream through Render's proxy (the step I was least sure of). From the Codespace, over the internet, on a free instance that was already awake: `/me` 146 ms, board 150 ms, register 728 ms, create team 829 ms. Atlas holds the seeded data (10K users, 2K teams, about 5K memberships). Cold starts after idle are not measured yet.

## v13: web page (patch 0021)

**Why:** a live URL that only speaks JSON cannot be judged on UX, and the brief needs a usable interface.
**What:** `GET /hackathons/:hid/my-team` (the page could not show your team otherwise), a plain JavaScript page served by the API, security headers with a Content-Security-Policy. React was dropped for a no-build page (DECISIONS D26).
**Result:** 6 new tests, 105 in total. The first real run was 104 of 105: the one failure was my own wrong assertion (anonymous requests to unknown paths get 401, not 404, because the session check runs first; fixed in patch 0022). The page was checked in a browser against a stub API and then by hand against the real server. A design flaw avoided: refreshing "your team" on every live event would send one uncached read per open page per event.

## v15: teammate suggestions and the people list (patch 0024)

**Why:** a re-read of the problem statement showed that suggestions are a must-have (I had labelled them optional), and that the board must show people as well as teams.
**What:** `GET /teams/:id/suggestions` (score = 0.6 skill complement + 0.4 time-zone overlap, each part and reason returned, members only, rate limited) and `GET /hackathons/:hid/people` (cached like the board, refreshed on every write and on every sign-up). Pure scoring functions in `src/suggestions.js`; queries in `src/people.js`.
**Result:** 17 new tests, 122 in total: the 10 scoring unit tests pass in isolation; the 7 HTTP tests are not yet run against a database. Not on the page yet: that waits for the React rewrite.

### v16: React UI
**Why:** the problem statement asks for a React UI and for suggestions and people on the page; the plain page covered neither.
**What:** Vite + React app in `web/` (auth with skills and time zone, tabs for teams and people, a side panel for your team on wide screens and a third tab on phones, invite code with copy and regenerate, join requests, suggestions with a "How is this scored?" breakdown, confirm dialogs, toasts, skeleton loading, dark mode, reduced motion). Express serves `dist/`. `public/` is removed.
**Checked:** bundled and driven in Chromium against a stub API: login error, register (with an XSS-style name), live pill, live board update, optimistic ask with rollback, create team, suggestions, optimistic decline with rollback, regenerate with a confirm dialog and Escape, phone width (no horizontal scroll), arrow keys on the tabs, leave, sign out. Not yet run against the real server.

### v17: edit your profile
**Why:** skills and time zone were set once at sign-up and could never change, so suggestions were only as good as a first guess, and accounts made before the new form had no skills at all.
**What:** `PATCH /me` (name, skills, time zone; any subset, at least one; strict schema, so email, password and ids cannot be sent; skills de-duplicated). It runs in one transaction with an audit entry (`PROFILE_UPDATED`, field names only) and with the copy of the name stored on teams the user leads (`leaderName`), so the board never shows an old name. The generic write hook drops the board cache and publishes a live event, so People and suggestions update at once. In the app: an "Edit profile" dialog (click your name), and a dismissible prompt while you have no skills.
**Checked:** the dialog and prompt in a browser against the stub. The 8 new API tests (`test/profile.test.js`) are written but not yet run against a database.

### v18: team-scoped live events
**Why:** a leader only learned about a new join request by polling every 15 s. Reading the code showed why: join requests and declines skipped the board cache invalidation, and that same flag also skipped the event, so nothing was ever pushed. The obvious fix, an event for every write, would make every open page re-read its own team on every event.
**What:** an event now says what changed: `board` (false for a request or decline, so pages skip the board read), `teams` (ids; they are already public on the board) and `me` (true when the person on that stream is involved, decided per stream so no event contains another user's id). Bursts merge: flags are OR-ed and ids unioned, and more than 100 ids collapse to "any". The page re-reads "your team" only when an event names its team or it is involved; the poll is now a 60 s safety net. A profile edit says "any team", since a name can appear anywhere.
**Checked:** the merge logic in isolation (6 assertions, run in a scratch script) and in a browser against a stub (the request appears in under 3 s with no polling). The 3 new HTTP tests (join request wakes the leader with `board:false`; accepting tells the requester `me:true` and a bystander `me:false`) have not been run against a database.

## Decisions outside the patches

- **Dropped `mongodb-memory-server`.** Its `mongod` binary ran but failed to start in the codespace within its timeout. Development, tests and load runs use a Docker replica set.
- **Atlas M0 is for the live site only.** It caps operations at about 100 per second, which would measure the cap instead of the code. A smoke test confirmed that transactions work on it.

## Next

Team-scoped live events, minimum team size, the chaos test, validation of the remaining inputs.
