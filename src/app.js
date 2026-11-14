import express from 'express';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createTeam,
  joinByCode,
  getInvite,
  regenerateInvite,
  leaveTeam,
  removeMember,
  getBoard,
  getTeam,
  getMyTeam,
} from './teams.js';
import { createBoardCache } from './boardCache.js';
import { createBoardEvents } from './boardEvents.js';
import { requestContext } from './context.js';
import { idempotency } from './idempotency.js';
import { listAudit } from './auditQueries.js';
import {
  createTokens,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  registerUser,
  loginUser,
  getProfile,
  updateProfile,
} from './auth.js';
import { createRateLimiter } from './rateLimit.js';
import { getPeople, getSuggestions } from './people.js';
import { parse, registerSchema, loginSchema, createTeamSchema, updateProfileSchema } from './validation.js';
import {
  createJoinRequest,
  listJoinRequests,
  acceptJoinRequest,
  declineJoinRequest,
  cancelJoinRequest,
} from './requests.js';

const BOARD_LIMIT = 20;
const PEOPLE_LIMIT = 20;

// Defaults. Tests pass `rateLimits: false` (off) or tighter numbers in `options`.
const DEFAULT_LIMITS = {
  authPerIp: { windowMs: 60_000, max: 30 }, // register and login, per IP address
  loginPerEmail: { windowMs: 15 * 60_000, max: 10 }, // login attempts per account
  codePerUser: { windowMs: 60_000, max: 10 }, // join-by-code attempts per user
  codePerIp: { windowMs: 60_000, max: 300 }, // and per IP, which may be a shared network
  suggestionsPerUser: { windowMs: 60_000, max: 20 }, // teammate suggestions (the heaviest read)
};

// Who an event is about. A profile edit can change names on any team, so it says "any".
function eventScope(req, body, board) {
  if (req.path === '/me') return { board };
  const ids = (...values) => values.filter((v) => v != null).map(String);
  return {
    board,
    teams: ids(req.params.id, body?.teamId, body?._id),
    users: ids(req.userId, req.params.uid, body?.userId, body?.removed, body?.newLeaderId),
  };
}

export function createApp(db, client, options = {}) {
  if (!options.secret) throw new Error('createApp needs options.secret (SESSION_SECRET)');
  const tokens = options.tokens ?? createTokens(options.secret);
  const secure = options.secureCookies ?? process.env.NODE_ENV === 'production';
  const boardCache = options.boardCache ?? createBoardCache();
  const boardEvents = options.boardEvents ?? createBoardEvents();
  const limits = options.rateLimits === false ? null : { ...DEFAULT_LIMITS, ...(options.rateLimits ?? {}) };
  const limiter = (name) => (limits ? createRateLimiter(limits[name]) : null);
  const noop = (req, res, next) => next();
  const limitBy = (name, keyFn) => limiter(name)?.middleware(keyFn) ?? noop;

  const app = express();
  app.set('etag', false); // the cached board body is served as is
  if (options.trustProxy) app.set('trust proxy', options.trustProxy); // behind a host's proxy, req.ip is the client

  // Every request gets an id, echoed back in X-Request-Id.
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.requestId = incoming && /^[A-Za-z0-9_.:-]{1,64}$/.test(incoming) ? incoming : randomUUID();
    res.set('X-Request-Id', req.requestId);
    next();
  });

  app.use(express.json({ limit: '10kb' }));

  // The audit log reads the request id and the acting user from this context. It starts after
  // the body is parsed, because async context does not follow stream events; the acting user
  // is filled in once the request is authenticated.
  app.use((req, res, next) => requestContext.run({ requestId: req.requestId, actorId: null }, next));
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // Security headers on every response. The page loads only its own script and style, so the
  // policy forbids everything else: injected markup could not load or run foreign code.
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
        "base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    next();
  });

  // The web page: the React app built by `npm run build` into dist/. It talks to the API below.
  // Hashed asset files are cached for a year; index.html is never cached, so a deploy is picked up at once.
  const staticDir = options.staticDir ?? fileURLToPath(new URL('../dist', import.meta.url));
  app.use(
    express.static(staticDir, {
      setHeaders(res, file) {
        res.setHeader('Cache-Control', file.includes(`${'/'}assets${'/'}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    }),
  );

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      if (err.status) {
        return res.status(err.status).json({ error: err.code, ...(err.details ? { details: err.details } : {}) });
      }
      console.error(err);
      res.status(500).json({ error: 'INTERNAL' });
    });

  // ---- accounts (no session needed) ----
  const authIp = limitBy('authPerIp', (req) => req.ip);
  const loginEmail = limiter('loginPerEmail');

  app.post(
    '/auth/register',
    authIp,
    wrap(async (req, res) => {
      const user = await registerUser(db, parse(registerSchema, req.body));
      setSessionCookie(res, tokens, user.id, { secure });
      // A new person appears in the "people looking for a team" list.
      boardCache.invalidate();
      boardEvents.publish({ board: true, teams: [], users: [user.id] });
      res.status(201).json({ user });
    }),
  );

  app.post(
    '/auth/login',
    authIp,
    wrap(async (req, res) => {
      const credentials = parse(loginSchema, req.body);
      if (loginEmail) {
        const { allowed, retryAfterSec } = loginEmail.hit(credentials.email);
        if (!allowed) {
          res.set('Retry-After', String(retryAfterSec));
          return res.status(429).json({ error: 'RATE_LIMITED' });
        }
      }
      const user = await loginUser(db, credentials);
      setSessionCookie(res, tokens, user.id, { secure });
      res.json({ user });
    }),
  );

  app.post('/auth/logout', (req, res) => {
    clearSessionCookie(res, { secure });
    res.json({ ok: true });
  });

  // ---- everything below needs a valid session ----
  app.use(requireAuth(tokens));

  app.get(
    '/me',
    wrap(async (req, res) => {
      res.json({ user: await getProfile(db, req.userId) });
    }),
  );

  // Retried writes return the stored answer instead of running twice.
  app.use(idempotency(db));

  // Any successful write may change the board, so drop the cache just before answering.
  // Routes that cannot change the board set res.locals.skipBoardInvalidation: they still send
  // an event (a leader must see a new join request), but one that says the board is unchanged.
  // The event names the teams and the people involved, read from the route and the response.
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400) {
          const boardChanged = !res.locals.skipBoardInvalidation;
          if (boardChanged) boardCache.invalidate(); // first, so a client woken by the event reads fresh data
          boardEvents.publish(eventScope(req, body, boardChanged));
        }
        return json(body);
      };
    }
    next();
  });

  // Edit your own profile. The generic hook below drops the board cache and publishes an event,
  // so the People tab and any team you lead update live.
  app.patch(
    '/me',
    wrap(async (req, res) => {
      res.json({ user: await updateProfile(db, client, req.userId, parse(updateProfileSchema, req.body)) });
    }),
  );

  app.post(
    '/hackathons/:hid/teams',
    wrap(async (req, res) => {
      const { name } = parse(createTeamSchema, req.body);
      const team = await createTeam(db, client, {
        hackathonId: req.params.hid,
        userId: req.userId,
        name,
      });
      res.status(201).json(team);
    }),
  );

  app.post(
    '/hackathons/:hid/join-by-code',
    limitBy('codePerUser', (req) => `user:${req.userId}`),
    limitBy('codePerIp', (req) => `ip:${req.ip}`),
    wrap(async (req, res) => {
      res.status(201).json(
        await joinByCode(db, client, {
          hackathonId: req.params.hid,
          code: req.body?.code,
          userId: req.userId,
        }),
      );
    }),
  );

  app.get(
    '/teams/:id/invite',
    wrap(async (req, res) => {
      res.json(await getInvite(db, { teamId: req.params.id, actorId: req.userId }));
    }),
  );

  app.post(
    '/teams/:id/invite/regenerate',
    wrap(async (req, res) => {
      res.json(await regenerateInvite(db, client, { teamId: req.params.id, actorId: req.userId }));
    }),
  );

  app.post(
    '/teams/:id/leave',
    wrap(async (req, res) => {
      res.json(await leaveTeam(db, client, { teamId: req.params.id, userId: req.userId }));
    }),
  );

  app.delete(
    '/teams/:id/members/:uid',
    wrap(async (req, res) => {
      res.json(
        await removeMember(db, client, {
          teamId: req.params.id,
          actorId: req.userId,
          targetUserId: req.params.uid,
        }),
      );
    }),
  );

  app.post(
    '/teams/:id/join-requests',
    wrap(async (req, res) => {
      res.locals.skipBoardInvalidation = true; // a request does not change the board
      res.status(201).json(await createJoinRequest(db, client, { teamId: req.params.id, userId: req.userId }));
    }),
  );

  app.get(
    '/teams/:id/join-requests',
    wrap(async (req, res) => {
      res.json(await listJoinRequests(db, { teamId: req.params.id, actorId: req.userId }));
    }),
  );

  app.post(
    '/teams/:id/join-requests/:rid/accept',
    wrap(async (req, res) => {
      res.json(
        await acceptJoinRequest(db, client, {
          teamId: req.params.id,
          requestId: req.params.rid,
          actorId: req.userId,
        }),
      );
    }),
  );

  app.post(
    '/teams/:id/join-requests/:rid/decline',
    wrap(async (req, res) => {
      res.locals.skipBoardInvalidation = true; // declining does not change the board
      res.json(
        await declineJoinRequest(db, client, {
          teamId: req.params.id,
          requestId: req.params.rid,
          actorId: req.userId,
        }),
      );
    }),
  );

  app.delete(
    '/teams/:id/join-requests/:rid',
    wrap(async (req, res) => {
      res.locals.skipBoardInvalidation = true; // cancelling does not change the board
      res.json(
        await cancelJoinRequest(db, client, {
          teamId: req.params.id,
          requestId: req.params.rid,
          userId: req.userId,
        }),
      );
    }),
  );

  app.get(
    '/teams/:id/audit',
    wrap(async (req, res) => {
      res.json(
        await listAudit(db, { teamId: req.params.id, actorId: req.userId, limit: req.query.limit }),
      );
    }),
  );

  app.get(
    '/hackathons/:hid/my-team',
    wrap(async (req, res) => {
      res.json(await getMyTeam(db, { hackathonId: req.params.hid, userId: req.userId }));
    }),
  );

  app.get(
    '/hackathons/:hid/people',
    wrap(async (req, res) => {
      // Like the board, one cached body serves everyone.
      const hackathonId = req.params.hid;
      const body = await boardCache.get(`${hackathonId}:people:${PEOPLE_LIMIT}`, async () =>
        JSON.stringify(await getPeople(db, { hackathonId, limit: PEOPLE_LIMIT })),
      );
      res.type('json').send(body);
    }),
  );

  app.get(
    '/teams/:id/suggestions',
    limitBy('suggestionsPerUser', (req) => `user:${req.userId}`),
    wrap(async (req, res) => {
      res.json(await getSuggestions(db, { teamId: req.params.id, actorId: req.userId, limit: req.query.limit }));
    }),
  );

  app.get(
    '/hackathons/:hid/board',
    wrap(async (req, res) => {
      // The board has no per-user content, so one cached body serves everyone.
      const hackathonId = req.params.hid;
      const body = await boardCache.get(`${hackathonId}:${BOARD_LIMIT}`, async () =>
        JSON.stringify(await getBoard(db, { hackathonId, limit: BOARD_LIMIT })),
      );
      res.type('json').send(body);
    }),
  );

  // Live updates: a signal that the board changed; the client re-reads the board.
  app.get('/hackathons/:hid/board/events', (req, res) => {
    const result = boardEvents.subscribe(req, res, req.userId);
    if (!result.ok) res.status(result.status).json({ error: result.error });
  });

  app.get(
    '/teams/:id',
    wrap(async (req, res) => {
      res.json(await getTeam(db, { teamId: req.params.id }));
    }),
  );

    // Anything not matched above, and errors thrown outside the route wrapper.
  app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'INVALID_JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    console.error(err);
    res.status(500).json({ error: 'INTERNAL' });
  });

  return app;
}
