import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { hashRequest } from '../src/idempotency.js';
import { checkInvariants } from '../src/invariants.js';

describe('request hashing', () => {
  const req = (body, url = '/x') => ({ method: 'POST', originalUrl: url, body });

  it('ignores key order in the body but not content, method or path', () => {
    expect(hashRequest(req({ a: 1, b: { c: 2, d: 3 } }))).toBe(hashRequest(req({ b: { d: 3, c: 2 }, a: 1 })));
    expect(hashRequest(req({ a: 1 }))).not.toBe(hashRequest(req({ a: 2 })));
    expect(hashRequest(req({ a: 1 }, '/x'))).not.toBe(hashRequest(req({ a: 1 }, '/y')));
    expect(hashRequest({ ...req({ a: 1 }), method: 'DELETE' })).not.toBe(hashRequest(req({ a: 1 })));
  });
});

describe('idempotency keys', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const key = (s) => ({ 'idempotency-key': `key-${s}-00000000` });
  const teamsLedBy = (userId) => env.db.collection('teams').countDocuments({ leaderId: userId });

  it('writes without a key are rejected, and so are malformed keys; reads need none', async () => {
    const none = await env.call('POST', '/hackathons/h1/teams', 'k0-user', { name: 'n' }, { 'idempotency-key': null });
    expect([none.status, none.body.error]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    const bad = await env.call('POST', '/hackathons/h1/teams', 'k0-user', { name: 'n' }, { 'idempotency-key': 'short' });
    expect([bad.status, bad.body.error]).toEqual([400, 'INVALID_IDEMPOTENCY_KEY']);
    expect(await teamsLedBy('k0-user')).toBe(0);
    expect((await env.call('GET', '/hackathons/h1/board', 'k0-user')).status).toBe(200);
  });

  it('T5: replaying a key returns the identical stored response and changes nothing', async () => {
    const h = key('t5');
    const first = await env.call('POST', '/hackathons/h1/teams', 't5-user', { name: 't5-team' }, h);
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replayed')).toBeNull();

    const second = await env.call('POST', '/hackathons/h1/teams', 't5-user', { name: 't5-team' }, h);
    expect(second.status).toBe(201);
    expect(second.body).toEqual(first.body); // same team id, same invite code
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await teamsLedBy('t5-user')).toBe(1);
  });

  it('T6: the same key with a different request returns 422 and does nothing', async () => {
    const h = key('t6');
    expect((await env.call('POST', '/hackathons/h1/teams', 't6-user', { name: 'one' }, h)).status).toBe(201);
    const other = await env.call('POST', '/hackathons/h1/teams', 't6-user', { name: 'two' }, h);
    expect([other.status, other.body.error]).toEqual([422, 'IDEMPOTENCY_KEY_REUSED']);
    const otherPath = await env.call('POST', '/teams/000000000000000000000000/leave', 't6-user', undefined, h);
    expect(otherPath.status).toBe(422);
    expect(await teamsLedBy('t6-user')).toBe(1);
  });

  it('T3: ten parallel requests with one key run once and all get the same answer (AC-3)', async () => {
    const h = key('t3');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => env.call('POST', '/hackathons/h1/teams', 't3-user', { name: 't3-team' }, h)),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    expect(new Set(results.map((r) => r.body._id)).size).toBe(1);
    expect(results.filter((r) => r.headers.get('idempotent-replayed') === 'true')).toHaveLength(9);
    expect(await teamsLedBy('t3-user')).toBe(1);
    expect(await env.db.collection('memberships').countDocuments({ userId: 't3-user' })).toBe(1);
    expect(await env.db.collection('auditLog').countDocuments({ action: 'TEAM_CREATED', targetUserId: 't3-user' })).toBe(1);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T3b: ten parallel joins with one key add the member exactly once', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 't3b-leader', { name: 't3b-team' });
    const code = await env.codeOf(created.body._id);
    const h = key('t3b');
    const results = await Promise.all(
      Array.from({ length: 10 }, () => env.joinByCode(code, 't3b-user', h)),
    );
    expect(new Set(results.map((r) => r.status))).toEqual(new Set([201]));
    const team = await env.db.collection('teams').findOne({ _id: new ObjectId(created.body._id) });
    expect(team).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T4: a double-clicked create-team (same key) makes one team', async () => {
    const h = key('t4');
    const [a, b] = await Promise.all([
      env.call('POST', '/hackathons/h1/teams', 't4i-user', { name: 't4i' }, h),
      env.call('POST', '/hackathons/h1/teams', 't4i-user', { name: 't4i' }, h),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body._id).toBe(b.body._id);
    expect(await teamsLedBy('t4i-user')).toBe(1);
  });

  it('keys are scoped to the user: two users may use the same key', async () => {
    const h = key('scope');
    const [a, b] = await Promise.all([
      env.call('POST', '/hackathons/h1/teams', 'scope-a', { name: 'scope-a-team' }, h),
      env.call('POST', '/hackathons/h1/teams', 'scope-b', { name: 'scope-b-team' }, h),
    ]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(a.body._id).not.toBe(b.body._id);
  });

  it('a failed answer is replayed too, even after the situation changes', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'fail-leader', { name: 'fail-team' });
    const teamId = created.body._id;
    const code = await env.codeOf(teamId);
    for (const m of ['a', 'b', 'c']) expect((await env.joinByCode(code, `fail-${m}`)).status).toBe(201);

    const h = key('fail');
    const full = await env.joinByCode(code, 'fail-late', h);
    expect([full.status, full.body.error]).toEqual([409, 'TEAM_FULL']);

    expect((await env.call('POST', `/teams/${teamId}/leave`, 'fail-c')).status).toBe(200); // a seat frees up
    const retry = await env.joinByCode(code, 'fail-late', h);
    expect([retry.status, retry.body.error]).toEqual([409, 'TEAM_FULL']); // the original answer
    expect(retry.headers.get('idempotent-replayed')).toBe('true');

    const fresh = await env.joinByCode(code, 'fail-late'); // a new key is a new attempt
    expect(fresh.status).toBe(201);
  });

  it('a stale "processing" record from a crashed request is taken over', async () => {
    const h = key('stale');
    const body = { name: 'stale-team' };
    await env.db.collection('idempotencyKeys').insertOne({
      userId: 'stale-user',
      key: h['idempotency-key'],
      requestHash: hashRequest({ method: 'POST', originalUrl: '/hackathons/h1/teams', body }),
      state: 'processing',
      startedAt: new Date(Date.now() - 120_000),
      createdAt: new Date(),
    });
    const res = await env.call('POST', '/hackathons/h1/teams', 'stale-user', body, h);
    expect(res.status).toBe(201);
    expect(await teamsLedBy('stale-user')).toBe(1);
  });

  it('the stored record holds the status and body of the answer', async () => {
    const h = key('err');
    const res = await env.call('POST', '/hackathons/h1/teams', 'err-user', { name: 'err-team' }, h);
    const rec = await env.db.collection('idempotencyKeys').findOne({ userId: 'err-user', key: h['idempotency-key'] });
    expect(rec).toMatchObject({ state: 'done', status: 201 });
    // The record keeps the raw document (ObjectId, Date); replay serializes it to the same JSON.
    expect(String(rec.body._id)).toBe(res.body._id);
  });
});
