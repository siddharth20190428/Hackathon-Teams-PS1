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
| Board p95 under 200 ms at 100 users | Not met at the latest measurement (207 ms); board cache is next. See [PERFORMANCE.md](PERFORMANCE.md) |
| Join requests (request, accept, decline, cancel) | Not built |
| Real authentication | Not built. A temporary `x-user-id` header names the caller |
| Idempotency keys, audit log, rate limits, input validation library | Not built |
| Live updates (SSE), teammate suggestions, React UI | Not built |
| CI | Workflow included; first run to be confirmed |
| Live deployment | Not deployed yet |

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
curl -s -X POST localhost:3000/hackathons/h1/teams \
  -H 'x-user-id: alice' -H 'content-type: application/json' -d '{"name":"Dream Team"}'
curl -s -H 'x-user-id: alice' localhost:3000/hackathons/h1/board
```

## Scripts

| Command | What it does |
|---|---|
| `npm start` | Runs the API on `PORT` (default 3000) |
| `npm run seed` | Wipes and reseeds the database named in `MONGODB_URI`, then checks invariants |
| `npm test` | Runs the full test suite (needs the MongoDB container running) |
| `RACE_ROUNDS=20 npm run test:race` | Runs the 50-way race test for 20 rounds instead of 5 |
| `LABEL=run1 DURATION=30s npm run load` | k6 load test on the board; prints a summary and writes `reports/<LABEL>.json`. Also accepts `VUS` and `BASE_URL` |
| `npm run explain:board` | Prints the query plan of the board query |

## API

Every route except `/healthz` needs the temporary `x-user-id` header. This is for development only and is not secure.

| Method and path | Who | Result |
|---|---|---|
| `GET /healthz` | anyone | `{ ok: true }` |
| `POST /hackathons/:hid/teams` with `{ name }` | any user not in a team | 201 and the team, including its invite code |
| `POST /hackathons/:hid/join-by-code` with `{ code }` | any user not in a team | 201 `{ teamId, userId }` |
| `GET /teams/:id/invite` | leader | `{ inviteCode, inviteExpiresAt }` |
| `POST /teams/:id/invite/regenerate` | leader | a new code; the old one stops working |
| `POST /teams/:id/leave` | member | `{ teamId, userId, teamDeleted, newLeaderId? }` |
| `DELETE /teams/:id/members/:uid` | leader | `{ teamId, removed }` |
| `GET /hackathons/:hid/board` | any user | `{ teams }`: open teams, newest first, invite fields hidden |
| `GET /teams/:id` | any user | the team, invite fields hidden |

Errors are JSON of the form `{ "error": "CODE" }`.

| Status | Codes |
|---|---|
| 400 | `INVALID_NAME`, `INVALID_CODE`, `USE_LEAVE` |
| 401 | `UNAUTHENTICATED` |
| 403 | `NOT_LEADER` |
| 404 | `NOT_FOUND`, `HACKATHON_NOT_FOUND`, `INVALID_CODE` (unknown code), `NOT_MEMBER` |
| 409 | `ALREADY_IN_TEAM`, `TEAM_FULL` |
| 410 | `CODE_EXPIRED` |

There is deliberately no way to join a team by its id alone. Joining needs an invite code (and, once built, an accepted join request).

## Project layout

```
src/app.js          Express routes (thin)
src/teams.js        All team operations: create, join by code, leave, remove, invite, board
src/tx.js           Transaction helper
src/indexes.js      The indexes the rules depend on
src/invariants.js   Consistency checker used by tests and the seed script
src/inviteCodes.js  Invite code generation and normalization
scripts/seed.js     Seed data and invariant check
load/board.js       k6 load test
test/               Vitest suites (race, join, leave, invite)
```

## More documentation

- [DESIGN.md](DESIGN.md): how races are prevented, data model, trade-offs.
- [DECISIONS.md](DECISIONS.md): the decisions and the evidence behind them.
- [TESTING.md](TESTING.md): test strategy, inventory, how to run.
- [PERFORMANCE.md](PERFORMANCE.md): load-test method, every run, honest caveats.
- [docs/ITERATIONS.md](docs/ITERATIONS.md): what each iteration changed and what the results showed.
