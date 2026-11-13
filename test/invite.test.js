import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';
import { newInviteCode, normalizeCode, isValidCode } from '../src/inviteCodes.js';

describe('invite code generation', () => {
  it('produces well-formed, unique codes with a safe alphabet', () => {
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
      const code = newInviteCode();
      expect(isValidCode(code)).toBe(true);
      seen.add(code);
    }
    expect(seen.size).toBe(2000);
  });

  it('normalizes case, spaces and look-alike characters', () => {
    expect(normalizeCode('  o1il ')).toBe('0111');
    expect(normalizeCode('abcdefghjk')).toBe('ABCDEFGHJK');
    expect(normalizeCode(null)).toBe('');
    expect(normalizeCode({ $ne: null })).toBe('');
  });
});

describe('joining by invite code', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const teamDoc = (id) => env.db.collection('teams').findOne({ _id: new ObjectId(id) });

  async function makeTeam(prefix, joiners = []) {
    const created = await env.call('POST', '/hackathons/h1/teams', `${prefix}-leader`, {
      name: `${prefix}-team`,
    });
    expect(created.status).toBe(201);
    for (const j of joiners) expect((await env.join(created.body._id, `${prefix}-${j}`)).status).toBe(201);
    return created.body._id;
  }

  it('a new team gets a code that expires after the hackathon TTL (48 h by default)', async () => {
    const teamId = await makeTeam('ttl');
    const team = await teamDoc(teamId);
    expect(isValidCode(team.inviteCode)).toBe(true);
    const hours = (team.inviteExpiresAt.getTime() - Date.now()) / 3600000;
    expect(hours).toBeGreaterThan(47);
    expect(hours).toBeLessThanOrEqual(48);
  });

  it('a correct code joins the team, and the code is accepted in any case', async () => {
    const teamId = await makeTeam('ok');
    const code = await env.codeOf(teamId);
    const res = await env.joinByCode(code.toLowerCase(), 'ok-newcomer');
    expect(res.status).toBe(201);
    expect(res.body.teamId).toBe(teamId);
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T9: a wrong code returns INVALID_CODE and a malformed one is rejected', async () => {
    const wrong = await env.joinByCode('ZZZZZZZZZZ', 't9-user');
    expect(wrong.status).toBe(404);
    expect(wrong.body.error).toBe('INVALID_CODE');
    for (const bad of ['', 'short', 'UUUUUUUUUU', { $ne: null }, null]) {
      const res = await env.joinByCode(bad, 't9-user');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_CODE');
    }
  });

  it('T8: an expired code is rejected with CODE_EXPIRED and nothing changes', async () => {
    const teamId = await makeTeam('t8');
    const code = await env.codeOf(teamId);
    await env.db
      .collection('teams')
      .updateOne({ _id: new ObjectId(teamId) }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
    const res = await env.joinByCode(code, 't8-late');
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('CODE_EXPIRED');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 1, openSeats: 3 });
  });

  it('a full team rejects a valid code with TEAM_FULL', async () => {
    const teamId = await makeTeam('full', ['a', 'b', 'c']);
    const res = await env.join(teamId, 'full-late');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('TEAM_FULL');
  });

  it('someone already in a team cannot join another by code', async () => {
    const teamA = await makeTeam('twoA');
    const teamB = await makeTeam('twoB');
    expect((await env.join(teamA, 'two-user')).status).toBe(201);
    const second = await env.join(teamB, 'two-user');
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('ALREADY_IN_TEAM');
    expect(await teamDoc(teamB)).toMatchObject({ memberCount: 1, openSeats: 3 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('joining directly by team id is not possible', async () => {
    const teamId = await makeTeam('direct');
    const res = await env.call('POST', `/teams/${teamId}/join`, 'direct-stranger');
    expect(res.status).toBe(404);
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 1 });
  });

  it('invite codes never appear on the board or the public team view', async () => {
    const teamId = await makeTeam('leak');
    const code = await env.codeOf(teamId);
    const board = await env.call('GET', '/hackathons/h1/board', 'leak-stranger');
    const view = await env.call('GET', `/teams/${teamId}`, 'leak-stranger');
    expect(board.body.teams.some((t) => t._id === teamId)).toBe(true);
    for (const body of [board.body, view.body]) {
      expect(JSON.stringify(body)).not.toContain('inviteCode');
      expect(JSON.stringify(body)).not.toContain(code);
    }
  });

  it('only the leader can see or regenerate the code', async () => {
    const teamId = await makeTeam('lead', ['a']);
    const code = await env.codeOf(teamId);

    const seen = await env.call('GET', `/teams/${teamId}/invite`, 'lead-leader');
    expect(seen.status).toBe(200);
    expect(seen.body.inviteCode).toBe(code);

    for (const user of ['lead-a', 'lead-stranger']) {
      const peek = await env.call('GET', `/teams/${teamId}/invite`, user);
      const regen = await env.call('POST', `/teams/${teamId}/invite/regenerate`, user);
      expect([peek.status, regen.status]).toEqual([403, 403]);
    }
    expect(await env.codeOf(teamId)).toBe(code);
  });

  it('regenerating makes the old code useless and the new one work', async () => {
    const teamId = await makeTeam('regen');
    const oldCode = await env.codeOf(teamId);
    const res = await env.call('POST', `/teams/${teamId}/invite/regenerate`, 'regen-leader');
    expect(res.status).toBe(200);
    expect(res.body.inviteCode).not.toBe(oldCode);
    expect((await env.joinByCode(oldCode, 'regen-late')).status).toBe(404);
    expect((await env.joinByCode(res.body.inviteCode, 'regen-late')).status).toBe(201);
    expect(await checkInvariants(env.db)).toEqual([]);
  });
});
