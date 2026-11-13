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

## D20. Board cache moves up
Rule agreed after the 60-second runs: if p95 is above 200 ms, or the margin is under 10%, the cache comes next. The v4 smoke run measured 207.1 ms, so an in-process cache with a short TTL and invalidation on writes is the next change. Cost: single instance only, and the board can be up to the TTL stale.
