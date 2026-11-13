import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

describe('leaving, removing and leader succession', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const teamDoc = (id) => env.db.collection('teams').findOne({ _id: new ObjectId(id) });
  const members = (id) =>
    env.db
      .collection('memberships')
      .find({ teamId: new ObjectId(id) })
      .sort({ joinedAt: 1, _id: 1 })
      .toArray();

  // Creates a team led by `${prefix}-leader`; each name in `joiners` joins in order.
  async function makeTeam(prefix, joiners = []) {
    const created = await env.call('POST', '/hackathons/h1/teams', `${prefix}-leader`, {
      name: `${prefix}-team`,
    });
    expect(created.status).toBe(201);
    const teamId = created.body._id;
    for (const j of joiners) {
      const res = await env.join(teamId, `${prefix}-${j}`);
      expect(res.status).toBe(201);
    }
    return teamId;
  }

  it('T16: when the leader leaves, the earliest-joined member becomes leader', async () => {
    const teamId = await makeTeam('t16', ['a', 'b']);
    const res = await env.call('POST', `/teams/${teamId}/leave`, 't16-leader');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ teamDeleted: false, newLeaderId: 't16-a' });
    expect(await teamDoc(teamId)).toMatchObject({ leaderId: 't16-a', memberCount: 2, openSeats: 2 });
    expect((await members(teamId)).map((r) => [r.userId, r.role])).toEqual([
      ['t16-a', 'leader'],
      ['t16-b', 'member'],
    ]);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T17: the last member leaving deletes the team and frees the person', async () => {
    const teamId = await makeTeam('t17');
    const res = await env.call('POST', `/teams/${teamId}/leave`, 't17-leader');
    expect(res.status).toBe(200);
    expect(res.body.teamDeleted).toBe(true);
    expect(await teamDoc(teamId)).toBeNull();
    expect(await members(teamId)).toHaveLength(0);
    const board = await env.call('GET', '/hackathons/h1/board', 't17-leader');
    expect(board.body.teams.some((t) => t._id === teamId)).toBe(false);
    const again = await env.call('POST', '/hackathons/h1/teams', 't17-leader', { name: 't17-again' });
    expect(again.status).toBe(201);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('a non-member leaving gets NOT_MEMBER and nothing changes', async () => {
    const teamId = await makeTeam('nm', ['a']);
    const res = await env.call('POST', `/teams/${teamId}/leave`, 'nm-stranger');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_MEMBER');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T12: a non-leader cannot remove a member', async () => {
    const teamId = await makeTeam('t12', ['a', 'b']);
    const res = await env.call('DELETE', `/teams/${teamId}/members/t12-b`, 't12-a');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_LEADER');
    expect(await members(teamId)).toHaveLength(3);
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 3, openSeats: 1 });
  });

  it('the leader can remove a member, who is then free to join another team', async () => {
    const teamId = await makeTeam('rm', ['a', 'b']);
    const res = await env.call('DELETE', `/teams/${teamId}/members/rm-a`, 'rm-leader');
    expect(res.status).toBe(200);
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2, leaderId: 'rm-leader' });
    expect((await members(teamId)).map((r) => r.userId)).toEqual(['rm-leader', 'rm-b']);
    const other = await makeTeam('rm-other');
    expect((await env.join(other, 'rm-a')).status).toBe(201);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('the leader cannot remove themselves (they use leave)', async () => {
    const teamId = await makeTeam('self', ['a']);
    const res = await env.call('DELETE', `/teams/${teamId}/members/self-leader`, 'self-leader');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('USE_LEAVE');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2 });
  });

  it('removing someone who is not a member rolls the seat count back', async () => {
    const teamId = await makeTeam('ghost', ['a']);
    const res = await env.call('DELETE', `/teams/${teamId}/members/nobody`, 'ghost-leader');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_MEMBER');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T18: the last member leaving while another user joins never corrupts the team', async () => {
    for (let i = 0; i < 20; i++) {
      const p = `t18-${i}`;
      const teamId = await makeTeam(p);
      const code = await env.codeOf(teamId);
      const [left, joined] = await Promise.all([
        env.call('POST', `/teams/${teamId}/leave`, `${p}-leader`),
        env.joinByCode(code, `${p}-x`),
      ]);
      expect(left.status).toBe(200);
      expect([201, 404]).toContain(joined.status);
      const team = await teamDoc(teamId);
      if (joined.status === 201) {
        // The join committed first, so the joiner inherited the team.
        expect(team).toMatchObject({ leaderId: `${p}-x`, memberCount: 1, openSeats: 3 });
      } else {
        // The team was deleted first, so the join found nothing.
        expect(team).toBeNull();
        expect(await members(teamId)).toHaveLength(0);
      }
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });

  it('two members leaving at once leave one consistent team led by the survivor', async () => {
    for (let i = 0; i < 10; i++) {
      const p = `two-${i}`;
      const teamId = await makeTeam(p, ['a', 'b']);
      const [r1, r2] = await Promise.all([
        env.call('POST', `/teams/${teamId}/leave`, `${p}-leader`),
        env.call('POST', `/teams/${teamId}/leave`, `${p}-a`),
      ]);
      expect([r1.status, r2.status]).toEqual([200, 200]);
      expect(await teamDoc(teamId)).toMatchObject({ leaderId: `${p}-b`, memberCount: 1, openSeats: 3 });
      expect((await members(teamId)).map((r) => [r.userId, r.role])).toEqual([[`${p}-b`, 'leader']]);
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });

  it('removing a member while they leave: exactly one of the two succeeds', async () => {
    for (let i = 0; i < 10; i++) {
      const p = `rl-${i}`;
      const teamId = await makeTeam(p, ['a']);
      const [removed, left] = await Promise.all([
        env.call('DELETE', `/teams/${teamId}/members/${p}-a`, `${p}-leader`),
        env.call('POST', `/teams/${teamId}/leave`, `${p}-a`),
      ]);
      expect([removed.status, left.status].sort()).toEqual([200, 404]);
      expect(await teamDoc(teamId)).toMatchObject({ memberCount: 1, openSeats: 3 });
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });
});
