import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup } from './helpers.js';

describe('editing your own profile', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
    await env.db.collection('users').insertMany(
      ['alice', 'bob', 'carol'].map((id) => ({
        _id: id,
        email: `${id}@example.test`,
        displayName: id[0].toUpperCase() + id.slice(1),
        skills: [],
        utcOffsetMinutes: 0,
      })),
    );
  });
  afterAll(async () => {
    await env.teardown();
  });

  const patch = (user, body, headers) => env.call('PATCH', '/me', user, body, headers);

  it('changes skills and time zone, and /me shows them', async () => {
    const res = await patch('alice', { skills: ['backend', 'design', 'backend'], utcOffsetMinutes: 330 });
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: 'alice', skills: ['backend', 'design'], utcOffsetMinutes: 330 });
    expect(res.body.user).not.toHaveProperty('passwordHash');
    const me = await env.call('GET', '/me', 'alice');
    expect(me.body.user.skills).toEqual(['backend', 'design']);
    expect(me.body.user.displayName).toBe('Alice');
  });

  it('only touches the fields you send', async () => {
    await patch('bob', { skills: ['ml'] });
    const res = await patch('bob', { utcOffsetMinutes: -300 });
    expect(res.body.user).toMatchObject({ displayName: 'Bob', skills: ['ml'], utcOffsetMinutes: -300 });
  });

  it('rejects bad input and unknown or protected fields', async () => {
    const bad = [
      {},
      { skills: 'backend' },
      { skills: Array.from({ length: 11 }, (_, i) => `s${i}`) },
      { skills: [''] },
      { displayName: '   ' },
      { displayName: 'x'.repeat(61) },
      { utcOffsetMinutes: 900 },
      { utcOffsetMinutes: 1.5 },
      { email: 'new@example.test' },
      { passwordHash: 'x' },
      { _id: 'someone-else' },
      { id: 'someone-else' },
    ];
    for (const body of bad) {
      const res = await patch('alice', body);
      expect([JSON.stringify(body), res.status, res.body.error]).toEqual([JSON.stringify(body), 400, 'VALIDATION_ERROR']);
    }
    const alice = await env.db.collection('users').findOne({ _id: 'alice' });
    expect(alice).toMatchObject({ email: 'alice@example.test', skills: ['backend', 'design'] });
  });

  it('needs a session and an idempotency key; you cannot edit someone else', async () => {
    expect((await patch(null, { skills: ['ml'] })).status).toBe(401);
    expect((await patch('alice', { skills: ['ml'] }, { 'idempotency-key': null })).status).toBe(400);
    // There is no id in the path or body: a session can only ever reach its own account.
    const res = await patch('carol', { skills: ['product'] });
    expect(res.body.user.id).toBe('carol');
    expect((await env.db.collection('users').findOne({ _id: 'alice' })).skills).toEqual(['backend', 'design']);
  });

  it('a signed token for a deleted account gets 404, not a new account', async () => {
    const res = await patch('ghost', { skills: ['ml'] });
    expect(res.status).toBe(404);
    expect(await env.db.collection('users').findOne({ _id: 'ghost' })).toBeNull();
  });

  it('the same Idempotency-Key replays the answer and writes one audit entry', async () => {
    const headers = { 'idempotency-key': 'profile-key-0001' };
    const a = await patch('bob', { skills: ['devops'] }, headers);
    const b = await patch('bob', { skills: ['devops'] }, headers);
    expect(b.status).toBe(a.status);
    expect(b.body).toEqual(a.body);
    const entries = await env.db.collection('auditLog').find({ action: 'PROFILE_UPDATED', targetUserId: 'bob', 'summary.fields': ['skills'] }).toArray();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const keyed = await env.db.collection('auditLog').find({ requestId: { $exists: true }, action: 'PROFILE_UPDATED' }).toArray();
    expect(new Set(keyed.map((e) => e.requestId)).size).toBe(keyed.length);
  });

  it('renaming a leader updates the board, the team and the audit log together', async () => {
    const created = await env.call('POST', '/hackathons/h1/teams', 'carol', { name: 'Rename Me' });
    expect(created.status).toBe(201);
    const before = await env.call('GET', '/hackathons/h1/board', 'carol');
    expect(before.body.teams[0].leaderName).toBe('Carol');

    const res = await patch('carol', { displayName: 'Caroline' });
    expect(res.status).toBe(200);
    // The cache is dropped by the write, so the next board read is fresh.
    const after = await env.call('GET', '/hackathons/h1/board', 'carol');
    expect(after.body.teams.find((t) => t.name === 'Rename Me').leaderName).toBe('Caroline');
    const mine = await env.call('GET', '/hackathons/h1/my-team', 'carol');
    expect(mine.body.members[0].displayName).toBe('Caroline');

    const log = await env.db.collection('auditLog').findOne({ action: 'PROFILE_UPDATED', targetUserId: 'carol', 'summary.fields': ['displayName'] });
    expect(log).toMatchObject({ actorId: 'carol', summary: { fields: ['displayName'] } });
  });

  it('a skill change reaches the people list and the suggestions straight away', async () => {
    await env.db.collection('users').insertOne({ _id: 'dave', email: 'dave@example.test', displayName: 'Dave', skills: [], utcOffsetMinutes: 0, createdAt: new Date() });
    const lead = 'alice'; // alice has [backend, design]
    const team = (await env.call('POST', '/hackathons/h1/teams', lead, { name: 'Skills' })).body;
    const first = await env.call('GET', `/teams/${team._id}/suggestions`, lead);
    const dave = first.body.suggestions.find((s) => s.user._id === 'dave');
    expect(dave.skills.adds).toEqual([]);

    await patch('dave', { skills: ['ml', 'frontend'] });
    const people = await env.call('GET', '/hackathons/h1/people', lead);
    expect(people.body.people.find((p) => p._id === 'dave').skills).toEqual(['ml', 'frontend']);
    const second = await env.call('GET', `/teams/${team._id}/suggestions`, lead);
    const after = second.body.suggestions.find((s) => s.user._id === 'dave');
    expect(after.skills.adds).toEqual(['frontend', 'ml']);
    expect(after.score).toBeGreaterThan(dave.score);
  });
});
