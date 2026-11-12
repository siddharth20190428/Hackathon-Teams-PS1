import express from 'express';
import { createTeam, joinTeam, getBoard, getTeam } from './teams.js';

export function createApp(db, client) {
  const app = express();
  app.use(express.json());
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  // TEMPORARY (replaced by real auth in I3): the caller is named by a header.
  app.use((req, res, next) => {
    req.userId = req.get('x-user-id');
    if (!req.userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });
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
    '/teams/:id/join',
    wrap(async (req, res) => {
      res.status(201).json(await joinTeam(db, client, { teamId: req.params.id, userId: req.userId }));
    }),
  );

  app.get(
    '/hackathons/:hid/board',
    wrap(async (req, res) => {
      res.json(await getBoard(db, { hackathonId: req.params.hid }));
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
