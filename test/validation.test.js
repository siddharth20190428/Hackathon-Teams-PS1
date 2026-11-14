import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';

// Every way input reaches the API is checked before it reaches the database.
describe('input validation', () => {
  let env;
  let team;
  beforeAll(async () => {
    env = await setup();
    const created = await env.call('POST', '/hackathons/h1/teams', 'val-lead', { name: 'validated' });
    team = created.body;
  });
  afterAll(async () => {
    await env.teardown();
  });

  const shape = (res) => [res.status, res.body?.error];

  describe('join code', () => {
    it('anything that is not a string is a VALIDATION_ERROR, never a database query', async () => {
      for (const bad of [undefined, null, 12, true, ['ZZZZZZZZZZ'], { $ne: null }, { $gt: '' }]) {
        const res = await env.call('POST', '/hackathons/h1/join-by-code', 'val-user', bad === undefined ? {} : { code: bad });
        expect([bad, ...shape(res)]).toEqual([bad, 400, 'VALIDATION_ERROR']);
      }
      expect(shape(await env.call('POST', '/hackathons/h1/join-by-code', 'val-user', { code: 'ZZZZZZZZZZ', extra: 1 }))).toEqual([400, 'VALIDATION_ERROR']);
      expect(shape(await env.call('POST', '/hackathons/h1/join-by-code', 'val-user', { code: 'A'.repeat(65) }))).toEqual([400, 'VALIDATION_ERROR']);
    });

    it('strings of the wrong shape are INVALID_CODE; a well-formed wrong code is INVALID_CODE with 404', async () => {
      for (const bad of ['', '   ', 'short', 'UUUUUUUUUU', 'A'.repeat(64), '../../etc', '<script>']) {
        expect([bad, ...shape(await env.joinByCode(bad, 'val-user'))]).toEqual([bad, 400, 'INVALID_CODE']);
      }
      expect(shape(await env.joinByCode('ZZZZZZZZZZ', 'val-user'))).toEqual([404, 'INVALID_CODE']);
    });
  });

  describe('?limit=', () => {
    const paths = (id) => [
      [`/teams/${id}/audit`, 200, 50],
      [`/teams/${id}/suggestions`, 20, 10],
    ];

    it('rejects anything that is not a whole number in range, and repeated parameters', async () => {
      for (const [path, max] of paths(team._id)) {
        for (const bad of ['abc', '', '0', '-1', '1.5', '1e2', '0x10', ' 5', `${max + 1}`, '9999', '1&limit=2']) {
          const res = await env.call('GET', `${path}?limit=${bad}`, 'val-lead');
          expect([path, bad, ...shape(res)]).toEqual([path, bad, 400, 'VALIDATION_ERROR']);
          expect(res.body.details[0].path).toBe('limit');
        }
      }
    });

    it('accepts the bounds and a missing limit', async () => {
      for (const [path, max] of paths(team._id)) {
        for (const ok of ['', '?limit=1', `?limit=${max}`]) {
          expect([path, ok, (await env.call('GET', path + ok, 'val-lead')).status]).toEqual([path, ok, 200]);
        }
      }
    });
  });

  describe('ids in the path', () => {
    const malformed = ['abcdefghijkl', 'zzzzzzzzzzzzzzzzzzzzzzzz', `${'a'.repeat(23)}`, `${'a'.repeat(25)}`, '..%2F..%2Fetc', '%24ne', 'null'];

    it('a malformed team id is a 404 on every route that takes one', async () => {
      const routes = [
        ['GET', '/teams/ID'],
        ['GET', '/teams/ID/invite'],
        ['GET', '/teams/ID/audit'],
        ['GET', '/teams/ID/suggestions'],
        ['GET', '/teams/ID/join-requests'],
        ['POST', '/teams/ID/lock'],
        ['POST', '/teams/ID/unlock'],
        ['POST', '/teams/ID/leave'],
        ['POST', '/teams/ID/invite/regenerate'],
        ['POST', '/teams/ID/join-requests'],
        ['DELETE', '/teams/ID/members/someone'],
      ];
      for (const id of malformed) {
        for (const [method, path] of routes) {
          const res = await env.call(method, path.replace('ID', id), 'val-lead', method === 'GET' ? undefined : {});
          expect([method, path, id, ...shape(res)]).toEqual([method, path, id, 404, 'NOT_FOUND']);
        }
      }
    });

    it('a malformed request id is a 404, and so is a well-formed one that does not exist', async () => {
      for (const action of ['accept', 'decline']) {
        for (const rid of ['nope', 'abcdefghijkl', new ObjectId().toString()]) {
          const res = await env.call('POST', `/teams/${team._id}/join-requests/${rid}/${action}`, 'val-lead', {});
          expect([action, rid, ...shape(res)]).toEqual([action, rid, 404, 'NOT_FOUND']);
        }
      }
    });

    it('a malformed user id in the path is a 404', async () => {
      for (const uid of ['x'.repeat(129), 'a%20b', '%24ne', 'a%2Fb']) {
        const res = await env.call('DELETE', `/teams/${team._id}/members/${uid}`, 'val-lead');
        expect([uid, ...shape(res)]).toEqual([uid, 404, 'NOT_FOUND']);
      }
    });
  });

  describe('hackathon id', () => {
    it('an unknown or malformed hackathon is a 404 on every route that takes one', async () => {
      for (const hid of ['nope', 'h1x', 'a'.repeat(41), '%24ne', 'h%201']) {
        for (const [method, path, body] of [
          ['GET', 'board'],
          ['GET', 'people'],
          ['GET', 'my-team'],
          ['POST', 'teams', { name: 'x' }],
          ['POST', 'join-by-code', { code: 'ZZZZZZZZZZ' }],
        ]) {
          const res = await env.call(method, `/hackathons/${hid}/${path}`, 'val-lead', body);
          expect([method, path, hid, res.status]).toEqual([method, path, hid, 404]);
          expect(['NOT_FOUND', 'HACKATHON_NOT_FOUND']).toContain(res.body.error);
        }
      }
      // And nothing was created or cached by those requests.
      expect(await env.db.collection('teams').countDocuments({ hackathonId: { $ne: 'h1' } })).toBe(0);
    });

    it('the real hackathon still works', async () => {
      expect((await env.call('GET', '/hackathons/h1/board', 'val-lead')).status).toBe(200);
      expect((await env.call('GET', '/hackathons/h1/people', 'val-lead')).status).toBe(200);
    });
  });

  describe('request bodies', () => {
    const post = (path, body, user) => env.call('POST', path, user, body);

    it('wrong types and unknown fields never reach the database', async () => {
      const cases = [
        ['/auth/register', { email: { $ne: null }, password: 'password123', displayName: 'x' }],
        ['/auth/register', { email: 'a@b.co', password: ['password123'], displayName: 'x' }],
        ['/auth/register', { email: 'a@b.co', password: 'password123', displayName: 'x', isAdmin: true }],
        ['/auth/register', { email: 'a@b.co', password: 'password123', displayName: 'x', skills: 'ml' }],
        ['/auth/login', { email: { $gt: '' }, password: { $gt: '' } }],
        ['/auth/login', { email: 'a@b.co' }],
        ['/hackathons/h1/teams', { name: { $ne: null } }, 'val-user-a'],
        ['/hackathons/h1/teams', { name: ['a'] }, 'val-user-a'],
        ['/hackathons/h1/teams', { name: 'x'.repeat(61) }, 'val-user-a'],
        ['/hackathons/h1/teams', { name: 'ok', leaderId: 'someone-else' }, 'val-user-a'],
      ];
      for (const [path, body, user] of cases) {
        const res = await post(path, body, user);
        expect([path, JSON.stringify(body), ...shape(res)]).toEqual([path, JSON.stringify(body), 400, 'VALIDATION_ERROR']);
      }
      expect(await env.db.collection('users').countDocuments({ email: 'a@b.co' })).toBe(0);
      expect(await env.db.collection('teams').countDocuments({ leaderId: 'someone-else' })).toBe(0);
    });

    it('malformed JSON and non-object JSON get a clean 400 without details of the parser', async () => {
      for (const rawBody of ['{', '{"a":', 'not json', '[1,2', '']) {
        const res = await env.raw('POST', '/auth/login', { rawBody });
        expect([rawBody, res.status]).toEqual([rawBody, 400]);
        expect(JSON.stringify(res.body)).not.toMatch(/at |node_modules|SyntaxError/);
      }
      for (const rawBody of ['[]', '"text"', '42', 'null']) {
        const res = await env.raw('POST', '/auth/login', { rawBody });
        expect([rawBody, res.status]).toEqual([rawBody, 400]);
      }
    });

    it('a body over 10 kB is refused with 413', async () => {
      const res = await env.raw('POST', '/auth/login', { rawBody: JSON.stringify({ email: 'a@b.co', password: 'x'.repeat(11_000) }) });
      expect(shape(res)).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    });
  });
});
