import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

// The test hackathon has minTeamSize 2 and maxTeamSize 4.
describe('minimum team size and locking', () => {
  let env;
  let n = 0;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const prefix = () => `ms${++n}`;
  const lock = (teamId, user) => env.call('POST', `/teams/${teamId}/lock`, user, {});
  const unlock = (teamId, user) => env.call('POST', `/teams/${teamId}/unlock`, user, {});
  const board = async () => (await env.call('GET', '/hackathons/h1/board?limit=200', 'viewer')).body.teams;

  // A team of `size` people led by `${p}-lead`.
  async function team(size) {
    const p = prefix();
    const created = await env.call('POST', '/hackathons/h1/teams', `${p}-lead`, { name: `team ${p}` });
    expect(created.status).toBe(201);
    for (let i = 1; i < size; i++) expect((await env.join(created.body._id, `${p}-m${i}`)).status).toBe(201);
    return { p, id: created.body._id, lead: `${p}-lead`, code: created.body.inviteCode };
  }

  it('a team is "forming" below the minimum and "ready" at it, on the board and on my-team', async () => {
    const t = await team(1);
    let mine = await env.call('GET', '/hackathons/h1/my-team', t.lead);
    expect(mine.body.team).toMatchObject({ status: 'forming', minSize: 2, memberCount: 1 });
    expect((await board()).find((x) => String(x._id) === t.id)).toMatchObject({ status: 'forming', minSize: 2 });

    await env.join(t.id, `${t.p}-m1`);
    mine = await env.call('GET', '/hackathons/h1/my-team', t.lead);
    expect(mine.body.team.status).toBe('ready');
    expect((await board()).find((x) => String(x._id) === t.id).status).toBe('ready');
  });

  it('a team below the minimum cannot be locked; a ready one can, and only its leader can', async () => {
    const t = await team(1);
    let res = await lock(t.id, t.lead);
    expect([res.status, res.body.error]).toEqual([409, 'TEAM_TOO_SMALL']);

    await env.join(t.id, `${t.p}-m1`);
    res = await lock(t.id, `${t.p}-m1`);
    expect([res.status, res.body.error]).toEqual([403, 'NOT_LEADER']);
    res = await lock(t.id, 'stranger');
    expect([res.status, res.body.error]).toEqual([403, 'NOT_LEADER']);
    expect((await lock(new ObjectId().toString(), t.lead)).status).toBe(404);
    expect((await lock('not-an-id', t.lead)).status).toBe(404);

    res = await lock(t.id, t.lead);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'locked', locked: true });
    res = await lock(t.id, t.lead);
    expect([res.status, res.body.error]).toEqual([409, 'ALREADY_LOCKED']);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('a locked team leaves the open board, takes nobody, and cancels pending requests', async () => {
    const t = await team(2);
    const asked = await env.call('POST', `/teams/${t.id}/join-requests`, 'asker-1', {});
    expect(asked.status).toBe(201);
    await lock(t.id, t.lead);

    expect((await board()).some((x) => String(x._id) === t.id)).toBe(false);
    const byCode = await env.joinByCode(t.code, 'late-1');
    expect([byCode.status, byCode.body.error]).toEqual([409, 'TEAM_LOCKED']);
    const request = await env.call('POST', `/teams/${t.id}/join-requests`, 'late-2', {});
    expect([request.status, request.body.error]).toEqual([409, 'TEAM_LOCKED']);
    const accept = await env.call('POST', `/teams/${t.id}/join-requests/${asked.body.requestId}/accept`, t.lead, {});
    expect([accept.status, accept.body.error]).toEqual([409, 'TEAM_LOCKED']);

    const stored = await env.db.collection('joinRequests').findOne({ _id: new ObjectId(asked.body.requestId) });
    expect(stored.status).toBe('cancelled');
    expect((await env.call('GET', '/hackathons/h1/my-team', 'late-1')).body.team).toBeNull();
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('unlocking reopens the team: back on the board, joins work again; only a locked team can be unlocked', async () => {
    const t = await team(2);
    let res = await unlock(t.id, t.lead);
    expect([res.status, res.body.error]).toEqual([409, 'NOT_LOCKED']);
    await lock(t.id, t.lead);
    res = await unlock(t.id, 'stranger');
    expect([res.status, res.body.error]).toEqual([403, 'NOT_LEADER']);
    res = await unlock(t.id, t.lead);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect((await board()).some((x) => String(x._id) === t.id)).toBe(true);
    expect((await env.joinByCode(t.code, `${t.p}-back`)).status).toBe(201);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('a locked team that drops below the minimum opens by itself (leave and removal)', async () => {
    for (const how of ['leave', 'remove']) {
      const t = await team(2);
      await lock(t.id, t.lead);
      const gone =
        how === 'leave'
          ? await env.call('POST', `/teams/${t.id}/leave`, `${t.p}-m1`, {})
          : await env.call('DELETE', `/teams/${t.id}/members/${t.p}-m1`, t.lead);
      expect(gone.status).toBe(200);
      const mine = await env.call('GET', '/hackathons/h1/my-team', t.lead);
      expect(mine.body.team).toMatchObject({ locked: false, status: 'forming', memberCount: 1 });
      expect((await board()).some((x) => String(x._id) === t.id)).toBe(true);
      const log = await env.db.collection('auditLog').findOne({ action: 'TEAM_UNLOCKED', teamId: new ObjectId(t.id) });
      expect(log.summary).toEqual({ reason: 'below_minimum' });
    }
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('a locked team that stays at or above the minimum stays locked when someone leaves', async () => {
    const t = await team(3);
    await lock(t.id, t.lead);
    await env.call('POST', `/teams/${t.id}/leave`, `${t.p}-m2`, {});
    const mine = await env.call('GET', '/hackathons/h1/my-team', t.lead);
    expect(mine.body.team).toMatchObject({ locked: true, status: 'locked', memberCount: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('lock racing 10 joins: every join either landed before the lock or got TEAM_LOCKED', async () => {
    for (let round = 0; round < 5; round++) {
      const t = await team(2); // 2 of 4: room for two more
      const joins = Array.from({ length: 10 }, (_, i) => env.joinByCode(t.code, `${t.p}-race${i}`));
      const [locked, ...results] = await Promise.all([lock(t.id, t.lead), ...joins]);
      expect(locked.status).toBe(200);
      const wins = results.filter((r) => r.status === 201).length;
      const closed = results.filter((r) => r.status === 409 && r.body.error === 'TEAM_LOCKED').length;
      const full = results.filter((r) => r.status === 409 && r.body.error === 'TEAM_FULL').length;
      expect(wins + closed + full).toBe(10);
      expect(wins).toBeLessThanOrEqual(2);
      const doc = await env.db.collection('teams').findOne({ _id: new ObjectId(t.id) });
      expect(doc).toMatchObject({ locked: true, memberCount: 2 + wins });
      // After the lock has answered, nobody else gets in.
      expect((await env.joinByCode(t.code, `${t.p}-after`)).body.error).toMatch(/TEAM_(LOCKED|FULL)/);
    }
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('lock racing the second member leaving: the team never ends locked below the minimum', async () => {
    for (let round = 0; round < 8; round++) {
      const t = await team(2);
      const [locked, left] = await Promise.all([lock(t.id, t.lead), env.call('POST', `/teams/${t.id}/leave`, `${t.p}-m1`, {})]);
      expect(left.status).toBe(200);
      expect([200, 409]).toContain(locked.status);
      if (locked.status === 409) expect(locked.body.error).toBe('TEAM_TOO_SMALL');
      const doc = await env.db.collection('teams').findOne({ _id: new ObjectId(t.id) });
      expect(doc).toMatchObject({ locked: false, memberCount: 1 });
    }
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('lock racing join requests: no pending request is ever left on a locked team', async () => {
    for (let round = 0; round < 8; round++) {
      const t = await team(2);
      const asks = Array.from({ length: 6 }, (_, i) => env.call('POST', `/teams/${t.id}/join-requests`, `${t.p}-ask${i}`, {}));
      const [locked, ...results] = await Promise.all([lock(t.id, t.lead), ...asks]);
      expect(locked.status).toBe(200);
      for (const r of results) expect([201, 409]).toContain(r.status);
      expect(await env.db.collection('joinRequests').countDocuments({ teamId: new ObjectId(t.id), status: 'pending' })).toBe(0);
    }
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('the invariant checker notices a locked team below the minimum and a pending request on a locked team', async () => {
    const t = await team(2);
    const _id = new ObjectId(t.id);
    await env.db.collection('teams').updateOne({ _id }, { $set: { locked: true, lookingForTeammates: false, memberCount: 1, openSeats: 3 } });
    expect((await checkInvariants(env.db)).some((p) => p.startsWith('I-8'))).toBe(true);
    await env.db.collection('teams').updateOne({ _id }, { $set: { memberCount: 2, openSeats: 2 } });
    await env.db.collection('joinRequests').insertOne({ _id: new ObjectId(), hackathonId: 'h1', teamId: _id, userId: 'ghost', status: 'pending', createdAt: new Date() });
    expect((await checkInvariants(env.db)).some((p) => p.startsWith('I-9'))).toBe(true);
    await env.db.collection('joinRequests').deleteMany({ teamId: _id });
    await env.db.collection('teams').updateOne({ _id }, { $set: { locked: false, lookingForTeammates: true } });
    expect(await checkInvariants(env.db)).toEqual([]);
  });
});
