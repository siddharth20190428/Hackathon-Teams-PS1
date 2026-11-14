import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

describe('join and create rules under concurrency', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  it('T2: one user joining 20 teams at once ends up in exactly one (AC-2)', async () => {
    const teamIds = [];
    for (let i = 0; i < 20; i++) {
      const res = await env.call('POST', '/hackathons/h1/teams', `t2-leader-${i}`, {
        name: `t2-team-${i}`,
      });
      expect(res.status).toBe(201);
      teamIds.push(res.body._id);
    }
    const codes = await Promise.all(teamIds.map((id) => env.codeOf(id)));
    const results = await Promise.all(codes.map((code) => env.joinByCode(code, 't2-joiner')));
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.body?.error === 'ALREADY_IN_TEAM'),
    ).toHaveLength(19);
    expect(await env.db.collection('memberships').countDocuments({ userId: 't2-joiner' })).toBe(1);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T4: parallel create-team by the same user creates exactly one team', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        env.call('POST', '/hackathons/h1/teams', 't4-leader', { name: 't4-team' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(
      results.filter((r) => r.status === 409 && r.body?.error === 'ALREADY_IN_TEAM'),
    ).toHaveLength(19);
    expect(await env.db.collection('teams').countDocuments({ leaderId: 't4-leader' })).toBe(1);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T7: joining a full team returns TEAM_FULL and changes nothing', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 't7-leader', {
      name: 't7-team',
    });
    const teamId = created.body._id;
    for (const m of ['a', 'b', 'c']) {
      const joined = await env.join(teamId, `t7-${m}`);
      expect(joined.status).toBe(201);
    }
    const full = await env.join(teamId, 't7-late');
    expect(full.status).toBe(409);
    expect(full.body.error).toBe('TEAM_FULL');
    const team = await env.call('GET', `/teams/${teamId}`, 't7-late');
    expect(team.body.memberCount).toBe(4);
    expect(team.body.openSeats).toBe(0);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('a retry of a join that filled the team says ALREADY_IN_TEAM, not TEAM_FULL', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'retry-leader', { name: 'retry-team' });
    const teamId = created.body._id;
    const code = await env.codeOf(teamId);
    for (const m of ['a', 'b']) expect((await env.join(teamId, `retry-${m}`)).status).toBe(201);
    // The last seat: this person's join fills the team.
    expect((await env.joinByCode(code, 'retry-last')).status).toBe(201);
    // The answer was lost, so the client asks again with a different key (the original key
    // would just replay the stored 201). The team is now full, but the seat is theirs.
    const again = await env.joinByCode(code, 'retry-last');
    expect(again.status).toBe(409);
    expect(again.body.error).toBe('ALREADY_IN_TEAM');
    // Someone who really is late still hears TEAM_FULL.
    const late = await env.joinByCode(code, 'retry-late');
    expect(late.body.error).toBe('TEAM_FULL');
  });
});
