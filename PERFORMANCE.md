# Performance

Target: board endpoint p95 under 200 ms with 100 concurrent users on a dataset of 10,000 users and 2,000 teams.

**Current state: not met at the latest measurement (v4, p95 207.1 ms).** A board cache is the next change. This page records every run, including the ones that missed.

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

All times are in milliseconds. Every run had a 0% error rate. v1 and v3 did not change the board, so they were not measured.

## What the results show

1. **The index mattered.** The unindexed query examined all 2,000 documents (`SORT > COLLSCAN`); after the partial index it examined 20 (`LIMIT > FETCH > IXSCAN`). Throughput rose roughly threefold (about 300 to 800-1,000 requests per second) and p95 fell from 612-710 ms to 150-194 ms. My prediction before measuring was that the index alone would not be enough; it was wrong. The server-side time of the scan was only about 2 ms, so the likely reason is competition for the two shared cores, but that is an inference and was not measured.
2. **The margin was never comfortable.** Longer runs were slower than short ones (p95 150-155 ms at 30 s, 178-194 ms at 60 s), so the 30-second passes flattered the result.
3. **v4 crossed the threshold.** p95 207.1 ms, from one 30-second run. Between v2 and v4 the board changed in two ways: a projection now hides the invite fields, and the seeded documents carry two more fields. Neither is proven to be the cause; the spread between v2's own runs (150 to 194 ms) is of similar size, so this may be noise. Repeat runs at v4 are needed to tell the two apart.
4. **Tail outliers.** In six of seven runs the maximum latency exceeded 1.7 s. The cause is not known; connection warm-up, garbage collection and CPU contention with k6 are candidates, none tested.

## Caveats

- One machine, two cores, everything shared. A reviewer's hardware will differ.
- Atlas M0 caps operations at about 100 per second, so the deployed site cannot serve this load directly. The p95 evidence in this report is local.
- Only the board read was load-tested. A mixed scenario with concurrent joins is planned after the cache.

## Next

1. Repeat v4 runs to separate noise from regression.
2. In-process board cache with a short TTL, invalidated on writes (DECISIONS.md D20); re-measure at 30 s and 60 s.
3. Re-measure after authentication and idempotency are added, because they add per-request work.
4. Add a mixed read-and-join scenario, and a deployed smoke run.
