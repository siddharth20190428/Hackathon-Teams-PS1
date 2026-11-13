import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup } from './helpers.js';

describe('the cached board stays fresh after every kind of write', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const onBoard = async (teamId) => {
    const res = await env.call('GET', '/hackathons/h1/board', 'viewer');
    expect(res.status).toBe(200);
    return res.body.teams.some((t) => t._id === teamId);
  };

  it('a new team is on the board immediately, even after a cached read', async () => {
    expect((await env.call('GET', '/hackathons/h1/board', 'viewer')).body.teams).toEqual([]); // warms the cache
    const created = await env.call('POST', '/hackathons/h1/teams', 'fresh-leader', { name: 'fresh-team' });
    expect(created.status).toBe(201);
    expect(await onBoard(created.body._id)).toBe(true);
  });

  it('a team leaves the board when it fills up and returns when someone leaves', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'fill-leader', { name: 'fill-team' });
    const teamId = created.body._id;
    expect(await onBoard(teamId)).toBe(true); // cached with the team on it
    for (const m of ['a', 'b', 'c']) {
      expect((await env.join(teamId, `fill-${m}`)).status).toBe(201);
    }
    expect(await onBoard(teamId)).toBe(false); // full: gone at once
    expect((await env.call('POST', `/teams/${teamId}/leave`, 'fill-c')).status).toBe(200);
    expect(await onBoard(teamId)).toBe(true); // a seat is free again
  });

  it('a deleted team disappears from the board immediately', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'gone-leader', { name: 'gone-team' });
    const teamId = created.body._id;
    expect(await onBoard(teamId)).toBe(true);
    expect((await env.call('POST', `/teams/${teamId}/leave`, 'gone-leader')).status).toBe(200);
    expect(await onBoard(teamId)).toBe(false);
  });
});
