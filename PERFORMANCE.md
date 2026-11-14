# Performance

Target: board endpoint p95 under 200 ms with 100 concurrent users on a dataset of 10,000 users and 2,000 teams.

**Current state: met in every run since the board cache was added (p95 39 to 42 ms, about 80% margin), locally on one machine.** Before the cache, the same code landed between 145 and 207 ms: 6 of 7 runs after the index passed, with margins as thin as 2%. This page records every run, including the ones that missed.

## Method

- Script: `load/board.js` (k6). 100 virtual users, constant, with no waiting between requests, `GET /hackathons/h1/board`, threshold `p(95) < 200 ms` and error rate under 1%.
- Command: `LABEL=<name> DURATION=30s npm run load`, with the server started by `npm start`. Summaries are written to `reports/<LABEL>.json`.
- Data: `npm run seed` (10,000 users, 2,000 teams, about 5,000 memberships; about 1,500 teams are open and appear on the board).
- Environment: GitHub Codespace with 2 cores. Node, MongoDB (Docker `mongo:7`, single-node replica set) and k6 all ran on the same machine, so they compete for the same cores. Results are pessimistic and noisy compared with separate machines.
- Because users never wait, average latency is about 100 divided by requests per second. At 982 requests per second, 100 / 982 = 0.102 s, and the measured average was 101 ms. Meeting the target therefore means serving roughly 1,000 requests per second on this machine.

## Results

| Version | Run | Requests per second | p50 | p90 | p95 | p99 | max | Threshold |
|---|---|---|---|---|---|---|---|---|
| v0 naive, no board index | 30 s, run 1 | 298.1 | 303.2 | 520.0 | 612.0 | 851.0 | 3531.1 | failed |
| v0 naive, no board index | 30 s, run 2 | 309.4 | 269.2 | 579.0 | 709.6 | 975.7 | 1760.5 | failed |
| v2 partial index | 30 s, run 1 | 982.2 | 92.3 | 135.9 | 155.0 | 213.8 | 3141.7 | passed |
| v2 partial index | 30 s, run 2 | 1021.7 | 91.6 | 133.0 | 149.6 | 186.4 | 2048.5 | passed |
| v2 partial index | 60 s, run 1 | 796.6 | 115.8 | 171.7 | 193.8 | 294.1 | 2798.9 | passed (3% margin) |
| v2 partial index | 60 s, run 2 | 880.3 | 106.2 | 157.6 | 178.0 | 233.0 | 382.5 | passed (11% margin) |
| v4 invite codes | 30 s, run 1 | 774.6 | 114.2 | 175.7 | 207.1 | 327.9 | 3001.9 | failed |
| v4 invite codes | 30 s, run 2 | 838.0 | 107.3 | 164.0 | 195.5 | 377.9 | 911.2 | passed (2% margin) |
| v4 invite codes | 30 s, run 3 | 945.6 | 99.8 | 145.2 | 162.1 | 201.1 | 870.7 | passed (19% margin) |
| v6 board cache on | 30 s, run 1 | 5072.2 | 16.7 | 34.6 | 42.4 | 61.9 | 165.1 | passed (about 79% margin) |
| v6 board cache on | 30 s, run 2 | 5236.2 | 16.3 | 33.2 | 41.2 | 60.9 | 139.4 | passed (about 79% margin) |
| v6 board cache on | 30 s, run 3 | 5264.2 | 16.2 | 32.9 | 40.2 | 60.3 | 162.9 | passed (about 80% margin) |
| v6 board cache on | 60 s, run 1 | 5351.5 | 16.1 | 32.1 | 39.3 | 56.1 | 153.4 | passed (about 80% margin) |
| v6 board cache on | 60 s, run 2 | 5380.4 | 16.0 | 31.8 | 39.0 | 57.0 | 159.0 | passed (about 80% margin) |
| v8 idempotency, audit, request ids (cache on) | 30 s, run 1 | 5411.2 | 15.7 | 31.8 | 39.3 | 56.7 | 385.5 | passed (about 80% margin) |
| v8 idempotency, audit, request ids (cache on) | 30 s, run 2 | 5415.2 | 15.8 | 31.8 | 39.3 | 56.2 | 114.4 | passed (about 80% margin) |
| v8 idempotency, audit, request ids (cache on) | 30 s, run 3 | 5569.1 | 15.3 | 31.1 | 38.1 | 54.6 | 102.1 | passed (about 81% margin) |
| v6 board cache off (`BOARD_CACHE_TTL_MS=0`) | 30 s, run 1 | 954.6 | 96.7 | 142.3 | 158.7 | 200.0 | 1894.8 | passed (21% margin) |
| v6 board cache off (`BOARD_CACHE_TTL_MS=0`) | 30 s, run 2 | 1017.2 | 91.4 | 132.9 | 152.2 | 203.1 | 1860.2 | passed (24% margin) |
| v6 board cache off (`BOARD_CACHE_TTL_MS=0`) | 30 s, run 3 | 1022.0 | 91.6 | 130.4 | 145.1 | 179.1 | 2319.8 | passed (27% margin) |

All times are in milliseconds. Every run had a 0% error rate. v1 and v3 did not change the board, so they were not measured. The v6 rows with the cache off are the same code as the cache-on rows, started with `BOARD_CACHE_TTL_MS=0`, so the pair is a like-for-like comparison.

## What the results show

1. **The index mattered.** The unindexed query examined all 2,000 documents (`SORT > COLLSCAN`); after the partial index it examined 20 (`LIMIT > FETCH > IXSCAN`). Throughput rose roughly threefold (about 300 to 800-1,000 requests per second) and p95 fell from 612-710 ms to 150-194 ms. My prediction before measuring was that the index alone would not be enough; it was wrong. The server-side time of the scan was only about 2 ms, so the likely reason is competition for the two shared cores, but that is an inference and was not measured.
2. **The margin was never comfortable.** Longer runs were slower than short ones (p95 150-155 ms at 30 s, 178-194 ms at 60 s), so the 30-second passes flattered the result.
3. **v4 is noise-limited, not clearly slower.** Three 30-second runs at v4 gave p95 of 207.1, 195.5 and 162.1 ms, a spread of about 45 ms. That overlaps v2's range (150 to 194 ms), so there is no evidence of a regression from the projection or the larger seeded documents. The practical finding is that on this machine the same code lands anywhere between about 150 and 207 ms, so a pass with a 2% margin is not reliable.
4. **Tail outliers.** In six of nine runs the maximum latency exceeded 1.7 s, although the last two runs peaked under 1 s. The cause is not known; connection warm-up, garbage collection and CPU contention with k6 are candidates, none tested (see point 6 for where it does and does not occur).
5. **The board cache fixed the margin.** With the cache on, p95 was 40.2, 41.2 and 42.4 ms in the 30 s runs and 39.0 and 39.3 ms in the 60 s runs, at 5,000 to 5,400 requests per second. The same code with the cache off gave 145.1, 152.2 and 158.7 ms at about 1,000 requests per second, in line with v2 and v4. The cache therefore lowered p95 about 3.7 times and raised throughput about 5 times, and the margin against the 200 ms target went from as little as 2% to about 80%. The average latency still follows the formula above: 100 / 5,236 is 19.1 ms, measured 18.9 ms.
6. **The multi-second outliers belong to the database path.** With the cache on, the maximum latency never exceeded 165 ms; the three cache-off runs peaked at 1.9 to 2.3 s. So the outliers come from the query path (candidates: connection warm-up, scan and sort contention), not from Node's HTTP handling. Not investigated further.

## After idempotency, audit and request ids (v8)

Patch 0012 adds an `AsyncLocalStorage` context and a request id to every request, and an extra write per mutation; reads skip the idempotency step. Three 30 s board runs after it gave p95 of 38.1 to 39.3 ms at 5,400 to 5,570 requests per second, the same as v6 (39.0 to 42.4 ms), so the read path shows no measurable cost. The write paths were not load-tested; they cost one extra database write each.

## After authentication (v9)

Patch 0015 puts a session check in front of every route: cookie or Bearer parsing, one HMAC-SHA256 with a constant-time compare, and a JSON parse. Three 30 s board runs with a minted token (`TOKEN=$(npm run -s token -- u1) LABEL=v9-1 npm run load`):

| Run | Requests per second | p50 | p90 | p95 | p99 | max | Threshold |
|---|---|---|---|---|---|---|---|
| v9 auth, cache on, run 1 | 4503.5 | 18.6 | 37.8 | 46.7 | 65.9 | 499.7 | passed (about 77% margin) |
| v9 auth, cache on, run 2 | 4477.3 | 18.6 | 38.1 | 47.2 | 68.6 | 236.8 | passed (about 76% margin) |
| v9 auth, cache on, run 3 | 4691.9 | 18.0 | 35.9 | 44.2 | 63.7 | 252.3 | passed (about 78% margin) |

Compared with v8 (p95 38.1 to 39.3 ms at about 5,400 to 5,570 requests per second), authentication added about 7 ms of p95 (+18%) and cost about 15% of throughput. My prediction of no visible change was wrong. Not optimized: memoizing verified tokens would add cache logic to a security path for a margin we already have.

## Live URL (free Render instance), board endpoint

Measured from the development Codespace over the internet with `load/board.js` and a token from `/auth/register`, against https://hackathon-teams.onrender.com (free instance, Atlas M0):

| Run | Requests per second | avg | p50 | p90 | p95 | p99 | max | Threshold |
|---|---|---|---|---|---|---|---|---|
| 1 user, 10 s (`live-rtt`) | 13.1 | 75.7 | 69.8 | 77.3 | 130.9 | 170.5 | 180.7 | n/a |
| 100 users, 30 s (`live-100`) | 159.3 | 619.7 | 689.6 | 902.5 | 1002.2 | 1587.2 | 1691.4 | failed |

Reading: one user alone sees p95 of 130.9 ms, so the network between the Codespace and the host already uses about two thirds of the 200 ms budget (average 75.7 ms). With 100 users who never pause the instance serves 159 requests per second, and 100 / 159 = 629 ms is the average latency, measured 620 ms: it is queueing on a small CPU share, not a slow query (the board is a cached read, about 0.4 ms of work per request on the two-core machine used for the local runs). The same code on the local machine reaches 4,500 to 5,500 requests per second. So the live URL does not meet p95 under 200 ms at 100 users who never pause, and no hosting change would fix the network share of that budget for a distant reader; the p95 evidence for this project is the server-side, local runs above. 0 errors in both runs.

## Caveats

- One machine, two cores, everything shared. A reviewer's hardware will differ.
- Atlas M0 caps operations at about 100 per second, so the deployed site cannot serve this load directly. The p95 evidence in this report is local.
- The board-only runs above are read-only and hit a single cache key, the best case for a cache. The mixed read, join and create runs further down include writes (every write invalidates the cache); in the realistic profile the board p95 was still 6.6 ms.
- At 5,000 or more requests per second, k6 and Node compete for the same two cores, so the cache-on latency (about 16 ms median) is mostly CPU contention on this machine, not database time.

## Write-path load test (procedure)

The board runs above are read-only. The write-path test mixes board reads, joins and team creation, and checks correctness afterwards, because a fast wrong answer does not count.

```
npm run seed
node --env-file=.env scripts/load-fixtures.js     # free users, 5 hot teams (fewest open seats), 300 other open teams
RATE_LIMITS=off npm start                         # terminal 1; limits would trip from a single IP
LABEL=w1 k6 run load/mixed.js                     # terminal 2
node --env-file=.env scripts/verify-load.js       # must print LOAD VERIFY PASSED
```

Half of the joins aim at the hot teams, so many users fight for the same few seats. Pass criteria: p95 under 200 ms for each of board, join and create; no 5xx; no 429 (which would mean the limits were on); and `verify-load` passing (all invariants, and no hot team over its open seats). Every write invalidates the board cache, so the board numbers here are the cache's worst case, not its best.

### Results: stress test (no think time)

Every run was started from a fresh seed and fresh fixtures. `verify-load` passed on all four runs (all invariants held; no hot team took more joiners than its 1 open seat). For the 100-user run the per-team lines were kept: each of the 5 hot teams went from 1 open seat to 0 with exactly 1 joiner. No 5xx in any run. Mix 70% read, 25% join, 5% create; times in ms.

| Users | req/s | board p95 | join p95 | create p95 |
|---|---|---|---|---|
| 10 | 487 | 11.9 | 91.5 | 105.3 |
| 25 | 517 | 32.4 | 195.9 | 233.9 |
| 50 | 517 | 71.6 | 343.9 | 421.0 |
| 100 | 464 | 169.6 | 707.4 | 859.9 |

Reading: throughput is flat from 10 to 100 users while latency grows in proportion to the user count (join p95 divided by users is 7 to 9 ms at every level). That is queueing at a ceiling of about 150 writes per second, not a per-request cost that grows. Top and `docker stats` during the runs showed mongod at 64 to 91% of a core, Node at 36 to 50%, k6 at 17 to 73% and docker-proxy at 9 to 17%, so the two shared cores are the limit; lock contention would leave CPU idle, and creates (no shared rows) are the slowest operation. With 10 users, all three operations are under 200 ms. At 100 users with no pause, the write target is missed by about 3.5 to 4 times.

My prediction before the first run was 30 to 150 ms for writes at 100 users; it was wrong by about 5 times, because I did not account for the load generator and the database sharing the same two cores.

Caveats: about 14,000 to 15,500 iterations ran against a pool of 4,000 users, so the pool wrapped and some 409 joins and non-201 creates are "already in a team" from reused users. k6 itself uses a large share of the CPU, so the app's real capacity is higher than measured. The deployed database (Atlas M0, about 100 operations per second) cannot be load-tested this way; the deployed site gets a smoke test only.

### Results: realistic profile (think time)

Prediction, written before the run: 100 users with a mean pause of 1 s will land near the 10-user numbers above (board about 12 ms, join about 90 ms, create about 105 ms p95), because the offered load (about 100 req/s) is well under the ceiling. Measured (`THINK_MS=1000 LABEL=w-think k6 run load/mixed.js`, 100 users, 30 s, fresh seed): 3,006 requests at 95.7 req/s; no 5xx; `verify-load` passed.

| Operation | p95 predicted | p95 measured | median | p99 | max |
|---|---|---|---|---|---|
| board | about 12 | 6.6 | 0.4 | 52.3 | 224.3 |
| join | about 90 | 73.5 | 11.0 | 270.2 | 297.2 |
| create | about 105 | 99.5 | 12.6 | 259.6 | 267.9 |

Joins: 303 won a seat, 439 refused (team full or already in a team). Creates: 132 of 132 succeeded. All three operations are under the 200 ms target at p95, with the prediction slightly conservative. The median write is 11 to 13 ms, which is the uncontended cost of a transaction here. Open item: write p99 is about 260 to 270 ms and the max about 300 ms, above the target even though the target is p95. I have not measured the cause; candidates are write-conflict retries on the 5 hot teams and database checkpoints. Together with the stress results above: under a realistic pause the service meets the target with a wide margin; its limit on this hardware is about 150 writes per second.

## Open items

1. Find the cause of the write p99 of about 260 to 270 ms (write-conflict retries on hot teams, or database checkpoints). Not investigated.
2. Run the write-path test on separate machines for the load generator and the database, to measure the app without k6 competing for the cores.
3. The deployed site (free instance, Atlas M0) was load-tested on the board only; the three live runs at 100 users gave p95 of 247, 196 and 344 ms. See [docs/LOAD_TEST_REPORT.md](docs/LOAD_TEST_REPORT.md).
