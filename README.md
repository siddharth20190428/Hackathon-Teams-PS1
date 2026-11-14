# Hackathon Teams (PS1): race-proof team formation

A team-formation service for a large hackathon (target: 10,000 participants) that stays correct when many people click at the same time. Built for the Hack4Hack Crew Hiring Challenge 2026, problem statement 1.

The core guarantee: when 50 people try to take the last seat in a team, exactly one succeeds, the other 49 get a clear error, and the data stays consistent. This is proven by an automated test that failed on the first, naive version (9 winners for 1 seat) and passes on the current one. See [TESTING.md](TESTING.md).

Stack: Node, Express 5, MongoDB (native driver, multi-document transactions), Vitest, k6.

## Status

| Area | State |
|---|---|
| Atomic seat claim, one team per person | Done |
| Create team, leave, remove member, leader succession, last member deletes the team | Done |
| Invite codes (expiry, regenerate, hidden from public views) | Done |
| Looking-for-teammates board | Done for the first page (20 teams); cursor pagination not built |
| Board p95 under 200 ms at 100 users | Met with the board cache (p95 39 to 42 ms; 44 to 47 ms after authentication was added); without the cache, the same code lands between 145 and 207 ms. Local, one machine. See [docs/LOAD_TEST_REPORT.md](docs/LOAD_TEST_REPORT.md) |
| Write paths under load (join, create) | Correct in every run (invariants held, no contested team over its seats). p95 under 200 ms with realistic pauses (join 73.5 ms, create 99.5 ms); misses it when 100 users never pause (saturation at about 150 writes per second on 2 shared cores) |
| Join requests (request, list, accept, decline, cancel) | Done |
| Real authentication | Done: email and password (scrypt), signed session token in an httpOnly cookie or Bearer header |
| Idempotency keys on every write, audit log per team | Done |
| Rate limits, input validation (zod) | Done: in-memory limits on login, auth and invite-code guesses; strict schemas |
| Live board updates (SSE) | Done: a "board changed" signal; the client re-reads the board |
| Deployment (Render + Atlas), smoke test | Done: https://hackathon-teams.onrender.com ; `scripts/smoke.js` passes against it. See [docs/DEPLOY.md](docs/DEPLOY.md) |
| React web app (Vite build, served by the API): sign in, live board of teams and people, create team, join with code, ask to join (optimistic, with rollback), manage your team, teammate suggestions with the score explained; works on a phone and with the keyboard, light and dark | Done; checked in a real browser against a stub API. Not yet checked against the running server |
| Teammate suggestions (ranked by complementary skills and time zone, scoring explained) | Done, on the API and in the app |
| "People looking for a team" list | Done on the API: `GET /hackathons/:hid/people`. Not on the page yet |
| CI | Workflow included; first run to be confirmed |

## Quick start

Prerequisites: Node 20 or newer (developed on Node 24), Docker, and k6 if you want to run the load test.

1. Start MongoDB as a single-node replica set. Transactions need a replica set.
```
docker run -d --name mongo -p 27017:27017 mongo:7 --replSet rs0
until docker exec mongo mongosh --quiet --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; do sleep 1; done
docker exec mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"localhost:27017"}]})'
```
After a restart of the machine or codespace, run `docker start mongo`. Do not remove the container unless you want to lose the data and initiate the replica set again.

2. Configure and install.
```
cp .env.example .env
npm ci
```
`.env` needs two values:
```
MONGODB_URI=mongodb://localhost:27017/teams_dev?replicaSet=rs0
PORT=3000
```

3. Seed the database with 10,000 users and 2,000 teams, then start the server.
```
npm run seed
npm start
```
The seed script refuses to wipe a database whose name does not contain `dev` or `seed`. It ends by checking the data invariants and exits non-zero if any fail.

4. Try it.
```
curl -s -c jar -X POST localhost:3000/auth/register -H 'content-type: application/json' \
  -d '{"email":"alice@example.com","password":"correct horse battery","displayName":"Alice"}'
curl -s -b jar -X POST localhost:3000/hackathons/h1/teams \
  -H 'idempotency-key: demo-0001' -H 'content-type: application/json' -d '{"name":"Dream Team"}'
curl -s -b jar localhost:3000/hackathons/h1/board
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the API on `PORT` (default 3000) |
| `BOARD_CACHE_TTL_MS=0 npm start` | Same, with the board cache off (default TTL is 2000 ms) |
| `npm run seed` | Wipes and reseeds the database named in `MONGODB_URI`, then checks invariants |
| `npm test` | Runs the full test suite (needs the MongoDB container running) |
| `RACE_ROUNDS=20 npm run test:race` | Runs the 50-way race test for 20 rounds instead of 5 |
| `LABEL=run1 DURATION=30s npm run load` | k6 load test on the board; prints a summary and writes `reports/<LABEL>.json`. Also accepts `VUS` and `BASE_URL` |
| `npm run token -- <userId>` | Prints a session token for a user id (needs `SESSION_SECRET`), for load tests: `TOKEN=$(npm run -s token -- u1) LABEL=run1 npm run load` |
| `node --env-file=.env scripts/load-fixtures.js` | Picks free users, hot teams and open teams after a seed and writes `load/fixtures.json` (not committed) |
| `RATE_LIMITS=off npm start` | Starts the API with rate limits off; for write-path load tests only |
| `LABEL=w1 k6 run load/mixed.js` | Write-path load test: 70% board reads, 25% joins (half aimed at a few hot seats), 5% team creates. Writes `reports/<LABEL>.json`. `VUS`, `DURATION` and `THINK_MS` (mean pause per user; default 0 is a stress test) are options |
| `node --env-file=.env scripts/verify-load.js` | After a load run: all invariants must hold and no hot team may exceed its open seats |
| `npm run explain:board` | Prints the query plan of the board query |

## API

Set `SESSION_SECRET` (32+ characters) in `.env` before starting; the server refuses to start without it: `echo "SESSION_SECRET=$(openssl rand -hex 32)" >> .env`.

Every route except `/healthz`, `POST /auth/register`, `POST /auth/login` and `POST /auth/logout` needs a session: the `session` cookie set by register or login, or an `Authorization: Bearer <token>` header. Tokens are HMAC-signed, expire after 7 days and are not stored server side, so logout only clears the cookie. Passwords are hashed with scrypt. Bad input gets 400 `VALIDATION_ERROR` with a `details` list; unknown fields are rejected. Rate limits answer 429 `RATE_LIMITED` with `Retry-After`: 30 auth requests per minute per IP, 10 login attempts per 15 minutes per email, 10 invite-code attempts per minute per user and 300 per IP. Limits are per process (single instance).

Every `POST` and `DELETE` also needs an `Idempotency-Key` header (8 to 128 characters: letters, digits, `_ . : -`). Send the same key when retrying a request: the first answer is stored and returned again (with `Idempotent-Replayed: true`) and nothing runs twice. The same key with a different request gets 422. Keys are per user and expire after 24 hours. Every response carries an `X-Request-Id` header (send your own `X-Request-Id` to choose it); the audit log records it.

`GET /hackathons/:hid/people` lists people who are in no team (newest first, 20, no email), cached and refreshed like the board. `GET /teams/:id/suggestions` (members of the team only, `?limit=` up to 20, default 10) ranks free people for the team: `score = 0.6 x skill complement + 0.4 x time-zone overlap`. Each suggestion carries its parts and plain-language reasons, and the response carries the method. See DECISIONS D12 and D27.

`PATCH /me` edits your own name, skills and time zone (any subset; email, password and ids are rejected). `GET /hackathons/:hid/my-team` returns your team, your role and the members with names; for the leader it also has the invite code and the pending join requests. The web app is served from `/` (built by `npm run build` into `dist/`; source in `web/`). `npm run dev:web` starts a Vite dev server on :5173 that proxies the API to :3000.

`GET /hackathons/:hid/board/events` is a server-sent event stream. Events: `ready` once on connect, then `board` with `{"version":n}` whenever a successful write may have changed the board (bursts are merged into one event, about a 100 ms window). It carries no data: re-read `GET /hackathons/:hid/board`. A client that reconnects or sees a version gap simply re-reads. Limits: 5 streams per user (429), 2,000 in total (503). Single instance only.

| Method and path | Who | Result |
|---|---|---|
| `GET /healthz` | anyone | `{ ok: true }` |
| `POST /hackathons/:hid/teams` with `{ name }` | any user not in a team | 201 and the team, including its invite code |
| `POST /hackathons/:hid/join-by-code` with `{ code }` | any user not in a team | 201 `{ teamId, userId }` |
| `GET /teams/:id/invite` | leader | `{ inviteCode, inviteExpiresAt }` |
| `POST /teams/:id/invite/regenerate` | leader | a new code; the old one stops working |
| `POST /teams/:id/leave` | member | `{ teamId, userId, teamDeleted, newLeaderId? }` |
| `DELETE /teams/:id/members/:uid` | leader | `{ teamId, removed }` |
| `POST /teams/:id/join-requests` | any user not in a team | 201 `{ requestId, teamId, userId, status }` |
| `GET /teams/:id/join-requests` | leader | `{ requests }`: pending requests, oldest first |
| `POST /teams/:id/join-requests/:rid/accept` | leader | `{ requestId, teamId, userId }`; the requester becomes a member |
| `POST /teams/:id/join-requests/:rid/decline` | leader | `{ requestId, status: "declined" }` |
| `DELETE /teams/:id/join-requests/:rid` | the requester | `{ requestId, status: "cancelled" }` |
| `GET /teams/:id/audit?limit=50` | team members | `{ entries }`: newest first, at most 200 |
| `GET /hackathons/:hid/board` | any user | `{ teams }`: open teams, newest first, invite fields hidden |
| `GET /teams/:id` | any user | the team, invite fields hidden |

Errors are JSON of the form `{ "error": "CODE" }`.

| Status | Codes |
|---|---|
| 400 | `INVALID_NAME`, `INVALID_CODE`, `USE_LEAVE`, `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_IDEMPOTENCY_KEY` |
| 401 | `UNAUTHENTICATED` |
| 403 | `NOT_LEADER`, `NOT_MEMBER` (audit log) |
| 404 | `NOT_FOUND`, `HACKATHON_NOT_FOUND`, `INVALID_CODE` (unknown code), `NOT_MEMBER` |
| 409 | `ALREADY_IN_TEAM`, `TEAM_FULL`, `ALREADY_REQUESTED`, `ALREADY_DECIDED`, `REQUESTER_UNAVAILABLE`, `IDEMPOTENCY_IN_PROGRESS` |
| 410 | `CODE_EXPIRED` |
| 422 | `IDEMPOTENCY_KEY_REUSED` |

There is deliberately no way to join a team by its id alone. Joining needs an invite code or an accepted join request.

## Project layout

```
src/app.js          Express routes (thin)
src/teams.js        All team operations: create, join by code, leave, remove, invite, board
src/tx.js           Transaction helper
src/indexes.js      The indexes the rules depend on
src/invariants.js   Consistency checker used by tests and the seed script
src/inviteCodes.js  Invite code generation and normalization
src/requests.js     Join requests: create, list, accept, decline, cancel
src/idempotency.js  Idempotency-Key middleware
src/audit.js        Audit entries, written inside each transaction
src/context.js      Per-request id and actor
src/requestCleanup.js  Voiding join requests when people join or teams are deleted
src/boardCache.js   In-process cache for the board response
scripts/seed.js     Seed data and invariant check
load/board.js       k6 load test
test/               Vitest suites (race, join, leave, invite, requests, idempotency, audit, auth, events, ...)
src/auth.js         Passwords (scrypt), signed session tokens, register and login
src/validation.js   zod schemas for request bodies
src/rateLimit.js    In-memory rate limiter
src/boardEvents.js  Server-sent events hub for live board updates
src/suggestions.js  Teammate scoring (pure functions)
src/people.js       People with no team, and teammate suggestions for a team
web/                React app (Vite). `npm run build` writes dist/, which the API serves
load/mixed.js       k6 write-path load test (reads, joins, creates)
scripts/load-fixtures.js, scripts/verify-load.js   Prepare and check a write-path load run
scripts/smoke.js    User journey against a deployed URL
render.yaml         Render blueprint (one free web service)
```

## More documentation

- [docs/DESIGN_DOC.md](docs/DESIGN_DOC.md): the design document (start here).
- [docs/LOAD_TEST_REPORT.md](docs/LOAD_TEST_REPORT.md): the load-test report.
- [docs/DEPLOY.md](docs/DEPLOY.md): deployment (Render and Atlas).
- [DESIGN.md](DESIGN.md): how races are prevented, data model, trade-offs (long form).
- [DECISIONS.md](DECISIONS.md): the decisions and the evidence behind them.
- [TESTING.md](TESTING.md): test strategy, inventory, how to run.
- [PERFORMANCE.md](PERFORMANCE.md): load-test method, every run, honest caveats.
- [docs/ITERATIONS.md](docs/ITERATIONS.md): what each iteration changed and what the results showed.
