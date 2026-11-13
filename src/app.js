import express from 'express';
import {
  createTeam,
  joinByCode,
  getInvite,
  regenerateInvite,
  leaveTeam,
  removeMember,
  getBoard,
  getTeam,
} from './teams.js';
import { createBoardCache } from './boardCache.js';
import {
  createJoinRequest,
  listJoinRequests,
  acceptJoinRequest,
  declineJoinRequest,
  cancelJoinRequest,
} from './requests.js';

const BOARD_LIMIT = 20;

export function createApp(db, client, options = {}) {
  const boardCache = options.boardCache ?? createBoardCache();
  const app = express();
  app.set('etag', false); // the cached board body is served as is
  app.use(express.json());
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // TEMPORARY (replaced by real auth in I3): the caller is named by a header.
  app.use((req, res, next) => {
    req.userId = req.get('x-user-id');
    if (!req.userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    next();
  });

  // Any successful write may change the board, so drop the cache just before answering.
  // Routes that cannot change the board set res.locals.skipBoardInvalidation.
  app.use((req, res, next) => {
    if (req.method !== 'GET') {
      const json = res.json.bind(res);
      res.json = (body) => {
        if (res.statusCode < 400 && !res.locals.skipBoardInvalidation) boardCache.invalidate();
        return json(body);
      };
    }
    next();
  });

  const wrap = (fn) => (req, res) =>
    fn(req, res).catch((err) => {
      if (err.status) return res.status(err.status).json({ error: err.code });
      console.error(err);
      res.status(500).json({ error: 'INTERNAL' });
    });

  app.post(
    '/hackathons/:hid/teams',
    wrap(async (req, res) => {
      const team = await createTeam(db, client, {
        hackathonId: req.params.hid,
        userId: req.userId,
        name: req.body?.name,
      });
      res.status(201).json(team);
    }),
  );

  app.post(
    '/hackathons/:hid/join-by-code',
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
      res.json(await regenerateInvite(db, { teamId: req.params.id, actorId: req.userId }));
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
      res.status(201).json(await createJoinRequest(db, { teamId: req.params.id, userId: req.userId }));
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
        await cancelJoinRequest(db, {
          teamId: req.params.id,
          requestId: req.params.rid,
          userId: req.userId,
        }),
      );
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

  app.get(
    '/teams/:id',
    wrap(async (req, res) => {
      res.json(await getTeam(db, { teamId: req.params.id }));
    }),
  );

  return app;
}
