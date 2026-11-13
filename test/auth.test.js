import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

const PASSWORD = 'correct horse battery';
const newEmail = (p) => `${p}-${Math.random().toString(36).slice(2, 8)}@example.test`;
const cookieOf = (res) => (res.headers.get('set-cookie') ?? '').split(';')[0]; // "session=..."

describe('accounts and sessions', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const register = (body, headers) => env.raw('POST', '/auth/register', { body, headers });
  const login = (body) => env.raw('POST', '/auth/login', { body });
  const signUp = async (p, extra = {}) => {
    const email = newEmail(p);
    const res = await register({ email, password: PASSWORD, displayName: `Name ${p}`, ...extra });
    expect(res.status).toBe(201);
    return { email, user: res.body.user, cookie: cookieOf(res), res };
  };

  it('registering creates an account and a session cookie that is HttpOnly and SameSite=Lax', async () => {
    const { email, user, cookie, res } = await signUp('reg', { skills: ['backend'], utcOffsetMinutes: 330 });
    expect(user).toMatchObject({ email, displayName: 'Name reg', skills: ['backend'], utcOffsetMinutes: 330 });
    expect(user.id).toMatch(/^u_/);
    expect(JSON.stringify(res.body)).not.toContain('passwordHash');
    const setCookie = res.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');

    const doc = await env.db.collection('users').findOne({ _id: user.id });
    expect(doc.passwordHash.startsWith('scrypt$')).toBe(true);
    expect(JSON.stringify(doc)).not.toContain(PASSWORD);

    const me = await env.raw('GET', '/me', { headers: { cookie } });
    expect(me.status).toBe(200);
    expect(me.body.user).toMatchObject({ id: user.id, email });
  });

  it('emails are unique ignoring case, even when ten registrations race', async () => {
    const email = newEmail('dup');
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        register({ email: i % 2 ? email.toUpperCase() : email, password: PASSWORD, displayName: 'Dup' }),
      ),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'EMAIL_TAKEN')).toHaveLength(9);
    expect(await env.db.collection('users').countDocuments({ email })).toBe(1);
  });

  it('login works with the right password, and wrong password and unknown email look identical', async () => {
    const { email } = await signUp('login');
    const ok = await login({ email: email.toUpperCase(), password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(cookieOf(ok)).toMatch(/^session=/);

    const wrong = await login({ email, password: 'not the password' });
    const unknown = await login({ email: newEmail('ghost'), password: PASSWORD });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(wrong.body).toEqual({ error: 'INVALID_CREDENTIALS' });
    expect(unknown.body).toEqual(wrong.body);
  });

  it('logout clears the cookie', async () => {
    const res = await env.raw('POST', '/auth/logout');
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toMatch(/^session=;/);
  });

  it('T21: every protected route answers 401 without a valid session', async () => {
    const calls = [
      ['GET', '/me'],
      ['GET', '/hackathons/h1/board'],
      ['GET', '/teams/000000000000000000000000'],
      ['POST', '/hackathons/h1/teams'],
      ['POST', '/hackathons/h1/join-by-code'],
      ['POST', '/teams/000000000000000000000000/leave'],
      ['GET', '/teams/000000000000000000000000/audit'],
    ];
    for (const [method, path] of calls) {
      const res = await env.raw(method, path, { body: method === 'GET' ? undefined : {} });
      expect([method, path, res.status, res.body?.error]).toEqual([method, path, 401, 'UNAUTHENTICATED']);
    }
  });

  it('the old x-user-id header no longer authenticates', async () => {
    const res = await env.raw('GET', '/hackathons/h1/board', { headers: { 'x-user-id': 'alice' } });
    expect(res.status).toBe(401);
  });

  it('rejects tampered, expired and foreign tokens, and accepts a valid Bearer token', async () => {
    const good = env.tokenFor('bearer-user');
    const [payload, sig] = good.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'someone-else', exp: 9_999_999_999 })).toString('base64url');
    const board = (token) => env.raw('GET', '/hackathons/h1/board', { headers: { authorization: `Bearer ${token}` } });

    expect((await board(good)).status).toBe(200);
    expect((await board(`${forged}.${sig}`)).status).toBe(401);
    expect((await board(`${payload}.${sig.slice(0, -2)}xx`)).status).toBe(401);
    expect((await board(env.tokenFor('bearer-user', { ttl: -10 }))).status).toBe(401);
    expect((await board('garbage')).status).toBe(401);
  });

  it('T20: operator-injection and malformed input is rejected before the database', async () => {
    const injections = [
      { email: { $ne: null }, password: PASSWORD },
      { email: newEmail('x'), password: { $ne: null } },
      { email: 'not-an-email', password: PASSWORD },
    ];
    for (const body of injections) {
      const res = await login(body);
      expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_ERROR']);
    }
    const bad = [
      { email: newEmail('s'), password: 'short', displayName: 'S' },
      { email: newEmail('n'), password: PASSWORD, displayName: '' },
      { email: newEmail('l'), password: PASSWORD, displayName: 'x'.repeat(61) },
      { email: newEmail('u'), password: PASSWORD, displayName: 'U', admin: true }, // unknown field
      { email: newEmail('o'), password: PASSWORD, displayName: { $gt: '' } },
      { email: newEmail('t'), password: PASSWORD, displayName: 'T', utcOffsetMinutes: 9999 },
    ];
    for (const body of bad) {
      const res = await register(body);
      expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_ERROR']);
      expect(Array.isArray(res.body.details)).toBe(true);
      expect(JSON.stringify(res.body)).not.toContain(PASSWORD);
    }
    const noBody = await env.raw('POST', '/auth/login', {});
    expect(noBody.status).toBe(400);
  });

  it('invalid JSON and oversized bodies get clean errors', async () => {
    const invalid = await env.raw('POST', '/auth/login', { rawBody: '{"email": ' });
    expect([invalid.status, invalid.body.error]).toEqual([400, 'INVALID_JSON']);
    const huge = await env.raw('POST', '/auth/login', { rawBody: JSON.stringify({ email: 'a', password: 'x'.repeat(20_000) }) });
    expect([huge.status, huge.body.error]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
  });

  it('create-team validates the name and uses the leader display name', async () => {
    const { user, cookie } = await signUp('lead');
    const write = (body) =>
      env.raw('POST', '/hackathons/h1/teams', { headers: { cookie, 'idempotency-key': `k-${Math.random()}-0000000` }, body });
    for (const body of [{}, { name: '' }, { name: 'x'.repeat(61) }, { name: { $ne: 1 } }, { name: 'ok', extra: 1 }]) {
      const res = await write(body);
      expect([res.status, res.body.error]).toEqual([400, 'VALIDATION_ERROR']);
    }
    const ok = await write({ name: '  Real Team  ' });
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ name: 'Real Team', leaderId: user.id, leaderName: 'Name lead' });
    const team = await env.db.collection('teams').findOne({ _id: new ObjectId(ok.body._id) });
    expect(team.leaderName).toBe('Name lead');
  });

  it('a cookie session works end to end: create team, then another user joins with the code', async () => {
    const a = await signUp('e2e-a');
    const b = await signUp('e2e-b');
    const post = (cookie, path, body) =>
      env.raw('POST', path, { headers: { cookie, 'idempotency-key': `k-${Math.random()}-0000000` }, body });
    const created = await post(a.cookie, '/hackathons/h1/teams', { name: 'e2e-team' });
    expect(created.status).toBe(201);
    const joined = await post(b.cookie, '/hackathons/h1/join-by-code', { code: created.body.inviteCode });
    expect(joined.status).toBe(201);
    expect(await env.db.collection('memberships').countDocuments({ teamId: new ObjectId(created.body._id) })).toBe(2);
    const audit = await env.raw('GET', `/teams/${created.body._id}/audit`, { headers: { cookie: a.cookie } });
    expect(audit.body.entries.map((e) => e.actorId)).toEqual([b.user.id, a.user.id]);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('unknown routes answer a JSON 404', async () => {
    const res = await env.raw('GET', '/nope', { headers: { authorization: `Bearer ${env.tokenFor('x1')}` } });
    expect([res.status, res.body.error]).toEqual([404, 'NOT_FOUND']);
  });
});

describe('rate limits on the API', () => {
  let env;
  beforeAll(async () => {
    env = await setup({
      rateLimits: {
        authPerIp: { windowMs: 60_000, max: 1000 },
        loginPerEmail: { windowMs: 60_000, max: 3 },
        codePerUser: { windowMs: 60_000, max: 3 },
        codePerIp: { windowMs: 60_000, max: 1000 },
      },
    });
  });
  afterAll(async () => {
    await env.teardown();
  });

  it('T10: guessing invite codes is blocked per user after the threshold, other users are unaffected (AC-5)', async () => {
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await env.joinByCode('ZZZZZZZZZZ', 'guesser'));
    expect(results.map((r) => r.status)).toEqual([404, 404, 404, 429, 429]);
    expect(results[3].body).toEqual({ error: 'RATE_LIMITED' });
    expect(Number(results[3].headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await env.joinByCode('ZZZZZZZZZZ', 'someone-else')).status).toBe(404);
  });

  it('login attempts per account are limited, even with the right password', async () => {
    const email = newEmail('brute');
    const reg = await env.raw('POST', '/auth/register', { body: { email, password: PASSWORD, displayName: 'Brute' } });
    expect(reg.status).toBe(201);
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const res = await env.raw('POST', '/auth/login', { body: { email, password: i < 2 ? 'wrong-password' : PASSWORD } });
      codes.push(res.status);
    }
    expect(codes).toEqual([401, 401, 200, 429, 429]);
  });

  it('the per-IP limit on register and login applies too', async () => {
    const tight = await setup({ rateLimits: { authPerIp: { windowMs: 60_000, max: 2 } } });
    try {
      const attempts = [];
      for (let i = 0; i < 4; i++) {
        attempts.push((await tight.raw('POST', '/auth/login', { body: { email: newEmail('ip'), password: PASSWORD } })).status);
      }
      expect(attempts).toEqual([401, 401, 429, 429]);
    } finally {
      await tight.teardown();
    }
  });
});
