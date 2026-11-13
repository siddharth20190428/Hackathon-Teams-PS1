# Decisions

Each decision gives the reason, the cost accepted, and the evidence gathered so far. "Amended" means a measurement or a bug changed an earlier choice.

## D1. Stack: Node, Express, native MongoDB driver, plain JavaScript
Reason: matches the organizer's stack, and the native driver keeps each atomic operation explicit and explainable. Rejected: Mongoose (hides what is atomic), TypeScript (setup time on a three-day budget). Cost: fewer compile-time checks, so tests carry more weight.

## D2. MongoDB as a replica set in Docker for development, tests and load runs (amended)
Reason: multi-document transactions need a replica set. Amended: the `mongodb-memory-server` binary ran but failed to start inside the codespace within its timeout, so it was dropped for a Docker `mongo:7` replica set. Atlas M0 is for the live deployment only; its limit of about 100 operations per second means the graded p95 is proven locally. Evidence: transactions confirmed working on Atlas M0 with a smoke test.

## D3. Seat claim: conditional update + unique index + transaction (amended)
See DESIGN.md section 4. Amended: the seat claim runs first and the membership insert second, so losers fail fast without writing rows. Evidence: the same race test went from 9 winners for 1 seat (naive) to 0 failures over 45 rounds of 50 contenders.

## D4. Idempotency keys
Every `POST` and `DELETE` requires an `Idempotency-Key`. The key is claimed with a unique `(userId, key)` insert; parallel duplicates wait and get the same stored answer; the same key with a different request is 422; 5xx releases the key; stale `processing` records are taken over after 30 s; records expire after 24 h. Rejected: caching only successes (a retry after a stored 409 would then behave differently from the original). Cost: one extra write per request, and the stored response is written just before it is sent, so a crash in that window re-runs the operation (safe: the atomic rules underneath still allow one outcome). Evidence: T3 (10 parallel requests, one key), T3b, T4, T5, T6 and four edge-case tests.

## D5. Live updates: server-sent events (planned)
One-way updates over plain HTTP with automatic reconnect. Single-instance fan-out; change streams are the upgrade path.

## D6. Authentication
Email and password, scrypt (built into Node, no extra dependency). A stateless HMAC-signed token in an httpOnly, SameSite=Lax cookie, also accepted as a Bearer header so load tests and curl work. Stateless means no session lookup on every request, at the price that a token cannot be revoked before it expires (7 days). A server-side session store is the upgrade if revocation is needed.

## D7. Rate limiting
In-memory fixed windows: auth per IP, login per email, invite-code attempts per user and per IP. Per process only, so it is exact for one instance and weaker behind several. The per-email login limit can be used to lock an account out for a window; accepted and recorded as a known trade-off.

## D24. Live updates are a signal, not data
SSE carries only a version number; the client re-reads the cached board. This keeps one rendering path for the board and one place where staleness is controlled (the cache invalidation). Events are published after the cache is invalidated, coalesced over 100 ms, and bounded by per-user and total stream caps. Rejected: pushing board diffs (a second read model that has to be kept correct under races) and WebSockets (two-way, not needed). Limit: in-process, so single instance, like the board cache.

## D8. Invite codes
50-bit codes from `crypto.randomBytes`, Crockford base32, unique, expiring (hackathon TTL, 48 h default), regenerable, case-insensitive with look-alike characters mapped. Stored in plain text so the leader can view them.

## D9. Team size semantics (assumption)
The spec gives a minimum and a maximum without saying what happens below the minimum. A team of any size from 1 to the maximum can exist; the maximum is enforced hard. The minimum is stored but does not block anything yet.

## D10. Leader succession
When the leader leaves, the remaining member with the earliest `joinedAt` (ties by `_id`) becomes leader.

## D11. Audit log
Append-only, written inside the same transaction as the change, so there is never a change without its entry or an entry without its change. Records actor, target, action, request id and a summary; never invite codes. Members read their team's log. Invariant I-7 reconciles the log with the member count. Cost: one extra write per change.

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

## D17. Temporary identity header (retired)
The `x-user-id` header served v1 to v8 so the concurrency work could be built first. Removed in v9; a test asserts it no longer authenticates.

## D23. Validation at the edge
zod strict schemas for register, login and create-team; unknown fields are rejected, strings are trimmed, emails lowercased. Invalid input gets 400 with field paths and never echoes the password.

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

## D22. Request ids and context
Each request gets an id (or uses a valid `X-Request-Id` from the client), echoed back in the `X-Request-Id` response header. It travels in an `AsyncLocalStorage` context together with the acting user, so audit entries get the actor and request id without extra arguments. Cost: a small per-request overhead. Measured on the board: none visible (p95 38 to 39 ms before and after); see PERFORMANCE.md.
