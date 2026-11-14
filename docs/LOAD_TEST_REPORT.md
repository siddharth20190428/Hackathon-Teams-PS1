# Load-test report

Goal: p95 under 200 ms with 100 concurrent users, on 10,000 users and 2,000 teams, without breaking correctness. This page is the summary. Every run, including the ones that missed, is in [PERFORMANCE.md](../PERFORMANCE.md); raw k6 summaries are in [`reports/`](../reports/).

## 1. Summary

| Question | Answer |
|---|---|
| Is the board read under 200 ms p95 at 100 users? | Yes: 44 to 47 ms with the cache and authentication (39 to 42 ms before authentication). Without the cache it is 145 to 207 ms, with a pass margin as thin as 2%. |
| Are joins and team creation under 200 ms p95 at 100 users? | Yes with realistic pauses (about 1 s between actions): join 73.5 ms, create 99.5 ms. No when users never pause: join 707 ms, create 860 ms. |
| Did correctness survive the load? | Yes. After each of five write-path runs, all invariants held and no contested team took more joiners than it had seats; in the two runs whose per-team output I kept, each of the five one-seat teams went from 1 open seat to 0 with exactly one new member. No 5xx in any run. |
| Does the live URL meet it? | No. On the free instance, one user alone sees p95 of 131 ms (network included), and 100 users who never pause get 155 to 159 requests per second and p95 of 1,002 to 1,202 ms (measured before and after gzip, see section 5). The p95 evidence in this report is server-side and local; see section 5. |
| What limits throughput? | About 150 writes per second on this machine: two shared cores, with the server, MongoDB and k6 all on them. |

## 2. Method

- **Tool:** k6, 100 virtual users, 30 s per run unless noted. Thresholds: p95 under 200 ms, errors under 1%.
- **Data:** `npm run seed`: 10,000 users, 2,000 teams, about 5,000 memberships; about 1,500 teams are open.
- **Environment:** a GitHub Codespace with 2 cores. Node, MongoDB (Docker `mongo:7`, single-node replica set) and k6 all run on it, so they compete for the same cores. Results are pessimistic and noisy compared with separate machines.
- **Read test** (`load/board.js`): `GET /hackathons/h1/board`, users never pause. Because users never pause, average latency is about 100 divided by requests per second.
- **Write-path test** (`load/mixed.js`): 70% board reads, 25% joins by invite code, 5% team creation. A fresh user acts each time. Half of the joins target five "hot" teams with one open seat each, so many users fight for the same seats. Rate limits are switched off for the run (from one IP they would trip at once). After each run, `scripts/verify-load.js` runs all invariant checks and confirms no hot team took more joiners than it had seats.
- **Two profiles:** a stress profile (no pause) and a realistic profile (a mean 1 s pause per action, about 96 requests per second in total).

## 3. Read path: from naive to cached

All times in ms.

| Version | What changed | Requests/s | p95 | Result |
|---|---|---|---|---|
| v0 | Naive board query, no index | 298 to 309 | 612 to 710 | failed |
| v2 | Partial index on exactly the board filter | 797 to 1,022 | 150 to 194 | passed, thin margins |
| v4 | Invite codes (projection, larger documents) | 775 to 946 | 162 to 207 | one run failed, one passed by 2% |
| v6 | In-process board cache (2 s TTL, shared loads, invalidated by every write) | 5,072 to 5,380 | 39 to 42 | passed, about 80% margin |
| v6, cache off | Same code, `BOARD_CACHE_TTL_MS=0` | 955 to 1,022 | 145 to 159 | passed, 21 to 27% margin |
| v8 | Idempotency, audit log, request ids | 5,411 to 5,569 | 38 to 39 | no measurable read cost |
| v9 | Authentication on every request | 4,477 to 4,692 | 44 to 47 | about 7 ms (+18%) and about 15% of throughput |

What mattered: the index cut the scanned documents from 2,000 to 20 and tripled throughput; the cache then cut p95 about 3.7 times and removed the multi-second outliers (maximum latency under 165 ms with the cache on, 1.9 to 2.3 s with it off), so the outliers belong to the database path. The 30 s runs flattered the result: 60 s runs were slower than 30 s runs for the uncached code.

## 4. Write path

### Stress profile (no pause), fresh seed per run

| Users | Requests/s | board p95 | join p95 | create p95 |
|---|---|---|---|---|
| 10 | 487 | 11.9 | 91.5 | 105.3 |
| 25 | 517 | 32.4 | 195.9 | 233.9 |
| 50 | 517 | 71.6 | 343.9 | 421.0 |
| 100 | 464 | 169.6 | 707.4 | 859.9 |

Throughput is flat from 10 to 100 users while latency grows in proportion to the user count (join p95 divided by users is 7 to 9 ms at every level). That is queueing behind a fixed ceiling of about 150 writes per second, not a per-request cost that grows. During the runs, mongod used 64 to 91% of a core, Node 36 to 50%, k6 17 to 73% and the Docker proxy 9 to 17%, so the two shared cores are the limit. Lock contention would leave CPU idle, and team creation (no shared rows) is the slowest operation, which also points away from contention. With 10 users every operation is under 200 ms. At 100 users who never pause, the write target is missed by about 3.5 to 4 times.

### Realistic profile (mean 1 s pause), 100 users

| Operation | p95 predicted before the run | p95 measured | median | p99 | max |
|---|---|---|---|---|---|
| board | about 12 | 6.6 | 0.4 | 52.3 | 224.3 |
| join | about 90 | 73.5 | 11.0 | 270.2 | 297.2 |
| create | about 105 | 99.5 | 12.6 | 259.6 | 267.9 |

3,006 requests at 95.7 requests per second; no 5xx; all invariants held. Of the joins, 303 won a seat and 439 were refused (team full or already in a team); 132 of 132 creates succeeded. The median write of 11 to 13 ms is the uncontended cost of a transaction here.

### Correctness under write load

In all five runs (`w1`, the 10, 25 and 50 user sweep runs, and the realistic run), `verify-load` passed: every data invariant held, no contested team took more joiners than it had seats, and no run had a 5xx. For `w1` and the realistic run I kept the per-team lines: each of the five one-seat teams went from 1 open seat to 0 with exactly one joiner. For the three sweep runs I kept only the final verdict. Each run made thousands of join attempts, so many users lost contested seats and received a clean refusal instead of a broken state.

## 5. Deployed smoke check (not a load test)

`scripts/smoke.js` against https://hackathon-teams.onrender.com, from the development Codespace over the internet, on a free instance that was already awake: `/me` 146 ms, board 150 ms, register 728 ms (scrypt on a small CPU share), create team 829 ms. The live update stream delivered an event through the host's proxy. 
**Board endpoint on the live URL** (`load/board.js`, from the same Codespace, token from `/auth/register`):

| Run | Requests/s | avg | p95 | p99 | max |
|---|---|---|---|---|---|
| 1 user, 10 s | 13.1 | 75.7 | 130.9 | 170.5 | 180.7 |
| 100 users, 30 s | 159.3 | 619.7 | 1002.2 | 1587.2 | 1691.4 |

The single-user run shows the network alone costs about 70 ms on average and 131 ms at p95 from this location. The 100-user run is queueing on the free instance's small CPU share: 100 / 159 = 629 ms, measured 620 ms. The same code reaches 4,500 to 5,500 requests per second locally, so the difference is the hosting tier, not the code or the query. The requirement is met on the server side by the local runs in section 3; the live URL is a demo on free tiers and does not meet it for 100 users who never pause. Any other number for the live URL would also depend on where the reader is.

**After v21 (precomputed gzip and ETag), same Codespace, same script:**

| Run | Requests/s | avg | p95 | p99 | max |
|---|---|---|---|---|---|
| 1 user, 10 s | 12.0 | 82.7 | 90.5 | 200.1 | 383.4 |
| 100 users, 30 s | 155.1 | 636.2 | 1201.9 | 1499.8 | 1592.2 |

Throughput did not move (155 against 159 requests per second), so the limit is not bytes on the wire; it is the work the free instance can do per second, about 6 ms of its CPU share per request. 100 / 155 = 645 ms, measured 636 ms. The p95 differs between the two runs by 200 ms with no change that should affect it, which is the run-to-run noise on a shared host: the 1-user p99 alone swung from 170 to 200 ms. v21 is still worth having (smaller answers, 304s for browsers) but it did not change this number, and I expected it to.

## 6. Where my predictions were wrong

| Prediction | What happened |
|---|---|
| The index alone would not be enough | It was enough: p95 went from 612 to 710 ms to 150 to 194 ms |
| The baseline board would pass | It did not, at 612 to 710 ms |
| Authentication would cost nothing visible | About 7 ms of p95 and 15% of throughput |
| Writes at 100 users would land at 30 to 150 ms | About 5 times worse with no pauses, because I forgot that the load generator and the database share the cores |
| Gzip and ETag (v21) would improve the live p95 | Throughput stayed at 155 requests per second and p95 was 1,202 ms against 1,002 ms before: the free instance is limited by CPU per request, not by bytes |

## 7. Limits of this evidence

- One machine, two cores, shared by the server, the database and the load generator. k6 itself uses a large share of the CPU, so the application's real capacity is higher than measured; a reviewer's hardware will differ.
- The stress runs used 14,000 to 15,500 iterations against a pool of 4,000 users, so the pool wrapped and some refusals are "already in a team" from reused users. This does not affect the invariant checks.
- Write p99 in the realistic profile is about 260 to 270 ms, above the target even though the target is p95. The cause is not measured (candidates: write-conflict retries on the hot teams, database checkpoints).
- Atlas M0 and the free web instance cannot serve the graded load (measured in section 5), so the p95 evidence is local.

## 8. Reproduce

```
npm run seed
# read path
TOKEN=$(npm run -s token -- u1) LABEL=read1 DURATION=30s npm run load
# write path (stress, then realistic)
node --env-file=.env scripts/load-fixtures.js
RATE_LIMITS=off npm start                                  # terminal 1
LABEL=w1 k6 run load/mixed.js                              # terminal 2: stress
node --env-file=.env scripts/verify-load.js                # must print LOAD VERIFY PASSED
THINK_MS=1000 LABEL=w-think k6 run load/mixed.js           # realistic (reseed and regenerate fixtures first)
```
