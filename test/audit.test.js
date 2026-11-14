import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

describe('audit log', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const log = async (teamId, actor) => {
    const res = await env.call('GET', `/teams/${teamId}/audit?limit=100`, actor);
    expect(res.status).toBe(200);
    return res.body.entries;
  };

  async function makeTeam(prefix) {
    const created = await env.call('POST', '/hackathons/h1/teams', `${prefix}-leader`, { name: `${prefix}-team` });
    expect(created.status).toBe(201);
    return created.body._id;
  }

  it('T22: every change writes an entry with the actor, the target and the request id', async () => {
    const teamId = await makeTeam('t22');
    const joined = await env.call('POST', '/hackathons/h1/join-by-code', 't22-a', { code: await env.codeOf(teamId) }, { 'x-request-id': 'req-join-0001' });
    expect(joined.status).toBe(201);
    expect(joined.headers.get('x-request-id')).toBe('req-join-0001');
    expect((await env.call('POST', `/teams/${teamId}/invite/regenerate`, 't22-leader')).status).toBe(200);
    expect((await env.call('DELETE', `/teams/${teamId}/members/t22-a`, 't22-leader')).status).toBe(200);

    const entries = await log(teamId, 't22-leader');
    expect(entries.map((e) => e.action)).toEqual([
      'MEMBER_REMOVED',
      'INVITE_REGENERATED',
      'MEMBER_JOINED',
      'TEAM_CREATED',
    ]); // newest first
    const byAction = Object.fromEntries(entries.map((e) => [e.action, e]));
    expect(byAction.TEAM_CREATED).toMatchObject({ actorId: 't22-leader', targetUserId: 't22-leader' });
    expect(byAction.MEMBER_JOINED).toMatchObject({ actorId: 't22-a', targetUserId: 't22-a', requestId: 'req-join-0001' });
    expect(byAction.MEMBER_REMOVED).toMatchObject({ actorId: 't22-leader', targetUserId: 't22-a' });
    for (const e of entries) {
      expect(e.requestId).toBeTypeOf('string');
      expect(new Date(e.ts).getTime()).toBeGreaterThan(0);
    }
    expect(await checkInvariants(env.db)).toEqual([]); // includes I-7
  });

  it('records join-request decisions with the leader as the actor', async () => {
    const teamId = await makeTeam('jr');
    const r1 = (await env.call('POST', `/teams/${teamId}/join-requests`, 'jr-x')).body.requestId;
    const r2 = (await env.call('POST', `/teams/${teamId}/join-requests`, 'jr-y')).body.requestId;
    expect((await env.call('POST', `/teams/${teamId}/join-requests/${r1}/accept`, 'jr-leader')).status).toBe(200);
    expect((await env.call('POST', `/teams/${teamId}/join-requests/${r2}/decline`, 'jr-leader')).status).toBe(200);
    const r3 = (await env.call('POST', `/teams/${teamId}/join-requests`, 'jr-z')).body.requestId;
    expect((await env.call('DELETE', `/teams/${teamId}/join-requests/${r3}`, 'jr-z')).status).toBe(200);

    const entries = await log(teamId, 'jr-leader');
    const by = (a) => entries.filter((e) => e.action === a);
    expect(by('JOIN_REQUESTED')).toHaveLength(3);
    expect(by('MEMBER_JOINED')[0]).toMatchObject({ actorId: 'jr-leader', targetUserId: 'jr-x', summary: { via: 'join_request' } });
    expect(by('JOIN_REQUEST_DECLINED')[0]).toMatchObject({ actorId: 'jr-leader', targetUserId: 'jr-y' });
    expect(by('JOIN_REQUEST_CANCELLED')[0]).toMatchObject({ actorId: 'jr-z', targetUserId: 'jr-z' });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('records leader succession and member departure', async () => {
    const teamId = await makeTeam('succ');
    expect((await env.join(teamId, 'succ-a')).status).toBe(201);
    expect((await env.call('POST', `/teams/${teamId}/leave`, 'succ-leader')).status).toBe(200);
    const entries = await log(teamId, 'succ-a');
    expect(entries.map((e) => e.action)).toEqual(['LEADER_CHANGED', 'MEMBER_LEFT', 'MEMBER_JOINED', 'TEAM_CREATED']);
    expect(entries[0]).toMatchObject({ actorId: 'succ-leader', targetUserId: 'succ-a', summary: { from: 'succ-leader' } });
  });

  it('a failed action leaves no entry (the log commits with the change)', async () => {
    const teamId = await makeTeam('nolog');
    const code = await env.codeOf(teamId);
    for (const m of ['a', 'b', 'c']) expect((await env.joinByCode(code, `nolog-${m}`)).status).toBe(201);
    const full = await env.joinByCode(code, 'nolog-late');
    expect(full.status).toBe(409);
    const entries = await log(teamId, 'nolog-leader');
    expect(entries.filter((e) => e.action === 'MEMBER_JOINED')).toHaveLength(3);
    expect(entries.some((e) => e.targetUserId === 'nolog-late')).toBe(false);
  });

  it('a deleted team keeps its history in the database', async () => {
    const teamId = await makeTeam('del');
    expect((await env.call('POST', `/teams/${teamId}/leave`, 'del-leader')).status).toBe(200);
    const rows = await env.db.collection('auditLog').find({ teamId: new ObjectId(teamId) }).toArray();
    expect(rows.map((r) => r.action).sort()).toEqual(['MEMBER_LEFT', 'TEAM_CREATED', 'TEAM_DELETED']);
  });

  it('only members can read the log, and it never contains invite codes', async () => {
    const teamId = await makeTeam('priv');
    const code = await env.codeOf(teamId);
    expect((await env.call('GET', `/teams/${teamId}/audit`, 'priv-stranger')).status).toBe(403);
    const missing = await env.call('GET', `/teams/${new ObjectId()}/audit`, 'priv-stranger');
    expect(missing.status).toBe(404);
    await env.call('POST', `/teams/${teamId}/invite/regenerate`, 'priv-leader');
    const entries = await log(teamId, 'priv-leader');
    expect(JSON.stringify(entries)).not.toContain(code);
    expect(JSON.stringify(entries)).not.toContain(await env.codeOf(teamId));
  });

  it('I-7: a team whose member count disagrees with its log is reported', async () => {
    const teamId = await makeTeam('tamper');
    await env.db.collection('teams').updateOne({ _id: new ObjectId(teamId) }, { $inc: { memberCount: 1, openSeats: -1 } });
    await env.db.collection('memberships').insertOne({
      hackathonId: 'h1', teamId: new ObjectId(teamId), userId: 'tamper-ghost', role: 'member', joinedAt: new Date(),
    });
    const problems = await checkInvariants(env.db);
    expect(problems.some((p) => p.startsWith('I-7') && p.includes(teamId))).toBe(true);
    // clean up so later tests in this file are unaffected
    await env.db.collection('memberships').deleteOne({ userId: 'tamper-ghost' });
    await env.db.collection('teams').updateOne({ _id: new ObjectId(teamId) }, { $inc: { memberCount: -1, openSeats: 1 } });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('the log comes with display names for the people in it', async () => {
    const reg = await env.raw('POST', '/auth/register', {
      body: { email: 'names@example.com', password: 'a-long-enough-password', displayName: 'Nadia Names' },
    });
    expect(reg.status).toBe(201);
    const leaderId = reg.body.user.id;
    const created = await env.call('POST', '/hackathons/h1/teams', leaderId, { name: 'names-team' });
    expect(created.status).toBe(201);
    const res = await env.call('GET', `/teams/${created.body._id}/audit`, leaderId);
    expect(res.status).toBe(200);
    expect(res.body.names[leaderId]).toBe('Nadia Names');
    // A person with no account record has no name; the entry is still there.
    const ghost = await makeTeam('ghost');
    const g = await env.call('GET', `/teams/${ghost}/audit`, 'ghost-leader');
    expect(g.body.entries).toHaveLength(1);
    expect(g.body.names).toEqual({});
  });
});
