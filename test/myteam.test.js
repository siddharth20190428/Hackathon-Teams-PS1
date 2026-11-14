import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup } from './helpers.js';

describe('my team and the web page', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
    const users = ['alice', 'bob', 'carol'].map((id) => ({
      _id: id,
      email: `${id}@example.test`,
      displayName: id[0].toUpperCase() + id.slice(1),
    }));
    await env.db.collection('users').insertMany(users);
  });
  afterAll(async () => {
    await env.teardown();
  });

  const mine = (user) => env.call('GET', '/hackathons/h1/my-team', user);

  it('needs a session', async () => {
    expect((await env.raw('GET', '/hackathons/h1/my-team')).status).toBe(401);
  });

  it('is empty for someone with no team', async () => {
    const res = await mine('alice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ team: null });
  });

  it('shows the leader the team, members with names, the invite code and pending requests', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'alice', { name: 'Mine Team' });
    expect(created.status).toBe(201);
    const asked = await env.call('POST', `/teams/${created.body._id}/join-requests`, 'carol');
    expect(asked.status).toBe(201);

    const res = await mine('alice');
    expect(res.body.role).toBe('leader');
    expect(res.body.team).toMatchObject({ name: 'Mine Team', memberCount: 1, openSeats: 3 });
    expect(res.body.team.inviteCode).toBe(created.body.inviteCode);
    expect(res.body.members.map((m) => [m.displayName, m.role])).toEqual([['Alice', 'leader']]);
    expect(res.body.requests.map((r) => [r.userId, r.displayName])).toEqual([['carol', 'Carol']]);
  });

  it('shows a member the team without the invite code or the requests', async () => {
    const team = (await mine('alice')).body.team;
    const joined = await env.joinByCode(team.inviteCode, 'bob');
    expect(joined.status).toBe(201);

    const res = await mine('bob');
    expect(res.body.role).toBe('member');
    expect(res.body.team.name).toBe('Mine Team');
    expect(res.body.team.inviteCode).toBeUndefined();
    expect(res.body.team.inviteExpiresAt).toBeUndefined();
    expect(res.body.requests).toEqual([]);
    expect(res.body.members.map((m) => m.displayName)).toEqual(['Alice', 'Bob']);
    expect(JSON.stringify(res.body)).not.toContain(team.inviteCode);
  });

  it('follows leadership changes and leaving', async () => {
    const left = await env.call('POST', `/teams/${(await mine('alice')).body.team._id}/leave`, 'alice');
    expect(left.status).toBe(200);
    expect((await mine('alice')).body).toEqual({ team: null });

    const bob = await mine('bob');
    expect(bob.body.role).toBe('leader');
    expect(bob.body.team.inviteCode).toMatch(/^[0-9A-Z]{10}$/);
    expect(bob.body.members.map((m) => m.displayName)).toEqual(['Bob']);
  });

  it('serves the page with security headers; unknown paths are 401 anonymous and a JSON 404 when signed in', async () => {
    const page = await env.raw('GET', '/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('x-frame-options')).toBe('DENY');

    const api = await env.raw('GET', '/hackathons/h1/board');
    expect(api.status).toBe(401); // the API is still behind the session
    // Unknown paths are behind the session too: anonymous callers learn nothing about them,
    // and signed-in callers get the JSON 404.
    const anonymous = await env.raw('GET', '/nope.js');
    expect(anonymous.status).toBe(401);
    const signedIn = await env.raw('GET', '/nope.js', { headers: { authorization: `Bearer ${env.tokenFor('alice')}` } });
    expect([signedIn.status, signedIn.body]).toEqual([404, { error: 'NOT_FOUND' }]);
  });
});
