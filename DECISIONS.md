# Decisions

Each decision gives the reason, the cost accepted, and the evidence gathered so far. "Amended" means a measurement or a bug changed an earlier choice.

## D1. Stack: Node, Express, native MongoDB driver, plain JavaScript
Reason: matches the organizer's stack, and the native driver keeps each atomic operation explicit and explainable. Rejected: Mongoose (hides what is atomic), TypeScript (setup time on a three-day budget). Cost: fewer compile-time checks, so tests carry more weight.

## D2. MongoDB as a replica set in Docker for development, tests and load runs (amended)
Reason: multi-document transactions need a replica set. Amended: the `mongodb-memory-server` binary ran but failed to start inside the codespace within its timeout, so it was dropped for a Docker `mongo:7` replica set. Atlas M0 is for the live deployment only; its limit of about 100 operations per second means the graded p95 is proven locally. Evidence: transactions confirmed working on Atlas M0 with a smoke test.

## D3. Seat claim: conditional update + unique index + transaction (amended)
See DESIGN.md section 4. Amended: the seat claim runs first and the membership insert second, so losers fail fast without writing rows. Evidence: the same race test went from 9 winners for 1 seat (naive) to 0 failures over 45 rounds of 50 contenders.

## D4. Idempotency keys (planned)
Mutating endpoints will require an `Idempotency-Key` header with a stored response. Until then, the unique membership index prevents duplicate memberships, but a retried request is not replayed identically.

## D5. Live updates: server-sent events (planned)
One-way updates over plain HTTP with automatic reconnect. Single-instance fan-out; change streams are the upgrade path.

## D6. Authentication (planned)
Signed token in an httpOnly cookie. Until it lands, see D17.

## D7. Rate limiting (planned)
In-memory, per IP and per user, on invite-code attempts, login and join.

## D8. Invite codes
50-bit codes from `crypto.randomBytes`, Crockford base32, unique, expiring (hackathon TTL, 48 h default), regenerable, case-insensitive with look-alike characters mapped. Stored in plain text so the leader can view them.

## D9. Team size semantics (assumption)
The spec gives a minimum and a maximum without saying what happens below the minimum. A team of any size from 1 to the maximum can exist; the maximum is enforced hard. The minimum is stored but does not block anything yet.

## D10. Leader succession
When the leader leaves, the remaining member with the earliest `joinedAt` (ties by `_id`) becomes leader.

## D11. Audit log (planned)
Append-only, written in the same transaction as the change.

## D12. Teammate scoring (planned)
Weighted skill complement and time-zone fit, with the breakdown returned.

## D13. Tests and load tools
Vitest, calling the app over HTTP with `fetch` against the Docker replica set, one fresh database per test file. k6 for load tests with a p95 threshold. CI starts the same replica set with Docker.

## D14. Single deployable (planned)
Express serves the built UI: one service, one URL.

## D15. Iterate, naive first
Iteration 0 was deliberately naive so the race test failed and the failure became evidence. Each iteration is a git tag with a performance record. Evidence: see docs/ITERATIONS.md.

## D16. AI usage rule
AI tools are allowed, but every line must be explainable. Each iteration is followed by a short note on why the code is the way it is.

## D17. Temporary identity header
Until real authentication lands, the caller is named by the `x-user-id` header. For development, tests and load runs only.

## D18. Direct join removed (security)
Versions v1 to v3 let any user join any team with a free seat by its id, bypassing invite codes. Removed in v4. A test asserts that the route is gone.

## D19. Invite codes hidden from public views
The board and the team view exclude invite fields; only the leader can read the code. A test asserts that neither the field name nor the code value appears.

## D20. Board cache
Rule agreed after the 60-second runs: if p95 is above 200 ms, or the margin is under 10%, the cache comes next. Evidence: after the index, p95 ranged from 150 to 207 ms across seven runs, with margins of 2% and 3% in two of them and one failure (207.1 ms). Three runs at v4 (207.1, 195.5 and 162.1 ms) showed that the spread is mostly run-to-run noise rather than a regression, but a pass that depends on luck is not a pass.

What was built: an in-process cache of the serialized board response (TTL 2 s by default; `BOARD_CACHE_TTL_MS=0` turns it off). Concurrent misses share one database load. Every successful write (any non-GET request answered with a status below 400) invalidates the whole cache just before the response is sent, and a load that was already running when the invalidation happened is not stored, so a stale read cannot outlive a write. At most 1,000 keys are kept, so random hackathon ids in the URL cannot grow it without bound. The board has no per-user content, so one cached body serves everyone. It also keeps the deployed site far below the Atlas M0 limit of about 100 operations per second.

Cost: single instance only. Another process would not see our invalidations; the TTL bounds the staleness, and change streams are the upgrade. Status: built and measured. With the cache on, p95 was 39 to 42 ms in five runs (about 80% margin) at 5,000 to 5,400 requests per second; with `BOARD_CACHE_TTL_MS=0` on the same code, p95 was 145 to 159 ms at about 1,000 requests per second. See PERFORMANCE.md.

## D21. Join request rules
- At most one pending request per person per team (partial unique index); a declined or cancelled person may ask again, and a person may have pending requests to several teams.
- Creating a request is rejected if the person is already in a team or the team is full, but those checks are not atomic with later events, so acceptance re-checks everything atomically.
- Accepting claims the seat first, with the leader check inside the filter, then decides the request, then inserts the membership (see DESIGN.md).
- Joining or creating a team voids the person's other pending requests; deleting a team voids its pending requests, all inside the same transaction.
- A request that creates, declines or cancels does not change the board, so it does not invalidate the board cache; accepting does.
- Evidence: 12 tests, including three races (two accepts for one seat, accept versus the requester joining elsewhere, accept versus the leader leaving).
