import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

describe('join requests', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  const teamDoc = (id) => env.db.collection('teams').findOne({ _id: new ObjectId(id) });
  const requestDoc = (id) => env.db.collection('joinRequests').findOne({ _id: new ObjectId(id) });
  const memberRows = (userId) => env.db.collection('memberships').find({ userId }).toArray();

  const ask = (teamId, userId) => env.call('POST', `/teams/${teamId}/join-requests`, userId);
  const list = (teamId, actor) => env.call('GET', `/teams/${teamId}/join-requests`, actor);
  const accept = (teamId, rid, actor) => env.call('POST', `/teams/${teamId}/join-requests/${rid}/accept`, actor);
  const decline = (teamId, rid, actor) => env.call('POST', `/teams/${teamId}/join-requests/${rid}/decline`, actor);
  const cancel = (teamId, rid, actor) => env.call('DELETE', `/teams/${teamId}/join-requests/${rid}`, actor);

  // Creates a team led by `${prefix}-leader`; each name in `joiners` joins in order.
  async function makeTeam(prefix, joiners = []) {
    const created = await env.call('POST', '/hackathons/h1/teams', `${prefix}-leader`, {
      name: `${prefix}-team`,
    });
    expect(created.status).toBe(201);
    const teamId = created.body._id;
    for (const j of joiners) {
      expect((await env.join(teamId, `${prefix}-${j}`)).status).toBe(201);
    }
    return teamId;
  }

  it('T13: a request is listed for the leader, and accepting it makes the requester a member', async () => {
    const teamId = await makeTeam('t13');
    const asked = await ask(teamId, 't13-user');
    expect(asked.status).toBe(201);
    expect(asked.body).toMatchObject({ teamId, userId: 't13-user', status: 'pending' });
    const rid = asked.body.requestId;

    const listed = await list(teamId, 't13-leader');
    expect(listed.status).toBe(200);
    expect(listed.body.requests.map((r) => r._id)).toEqual([rid]);

    const res = await accept(teamId, rid, 't13-leader');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ requestId: rid, teamId, userId: 't13-user' });
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect((await memberRows('t13-user')).map((m) => m.role)).toEqual(['member']);
    expect((await requestDoc(rid)).status).toBe('accepted');
    expect((await list(teamId, 't13-leader')).body.requests).toEqual([]);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T14: declining keeps the requester out, and they may ask again', async () => {
    const teamId = await makeTeam('t14');
    const rid = (await ask(teamId, 't14-user')).body.requestId;
    const res = await decline(teamId, rid, 't14-leader');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('declined');
    expect(await memberRows('t14-user')).toHaveLength(0);
    expect((await requestDoc(rid)).status).toBe('declined');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 1, openSeats: 3 });

    const again = await ask(teamId, 't14-user');
    expect(again.status).toBe(201);
    expect(again.body.requestId).not.toBe(rid);
  });

  it('T11: only the leader can list, accept or decline', async () => {
    const teamId = await makeTeam('t11', ['a']);
    const rid = (await ask(teamId, 't11-user')).body.requestId;
    for (const who of ['t11-a', 't11-stranger']) {
      const results = await Promise.all([list(teamId, who), accept(teamId, rid, who), decline(teamId, rid, who)]);
      expect(results.map((r) => r.status)).toEqual([403, 403, 403]);
      expect(results.map((r) => r.body.error)).toEqual(['NOT_LEADER', 'NOT_LEADER', 'NOT_LEADER']);
    }
    expect((await requestDoc(rid)).status).toBe('pending');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 2, openSeats: 2 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('only the requester can cancel, and a cancelled request cannot be accepted', async () => {
    const teamId = await makeTeam('can');
    const rid = (await ask(teamId, 'can-user')).body.requestId;
    expect((await cancel(teamId, rid, 'can-other')).status).toBe(404);

    const own = await cancel(teamId, rid, 'can-user');
    expect(own.status).toBe(200);
    expect(own.body.status).toBe('cancelled');

    const late = await accept(teamId, rid, 'can-leader');
    expect(late.status).toBe(409);
    expect(late.body.error).toBe('ALREADY_DECIDED');
    expect(await teamDoc(teamId)).toMatchObject({ memberCount: 1, openSeats: 3 }); // the seat claim rolled back
    expect((await cancel(teamId, rid, 'can-user')).status).toBe(409);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('rejects duplicate requests, requests from members, requests to full teams and to missing teams', async () => {
    const teamId = await makeTeam('guard', ['a', 'b']); // 3 of 4 seats
    const first = await ask(teamId, 'guard-user');
    expect(first.status).toBe(201);

    const dup = await ask(teamId, 'guard-user');
    expect([dup.status, dup.body.error]).toEqual([409, 'ALREADY_REQUESTED']);
    const member = await ask(teamId, 'guard-a');
    expect([member.status, member.body.error]).toEqual([409, 'ALREADY_IN_TEAM']);

    expect((await accept(teamId, first.body.requestId, 'guard-leader')).status).toBe(200); // team is now full
    const full = await ask(teamId, 'guard-late');
    expect([full.status, full.body.error]).toEqual([409, 'TEAM_FULL']);

    const ghost = await ask(new ObjectId().toString(), 'guard-user2');
    expect([ghost.status, ghost.body.error]).toEqual([404, 'NOT_FOUND']);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T15: a request is voided when the requester joins another team first', async () => {
    const teamA = await makeTeam('t15a');
    const teamB = await makeTeam('t15b');
    const rid = (await ask(teamA, 't15-user')).body.requestId;
    expect((await env.join(teamB, 't15-user')).status).toBe(201);
    expect((await requestDoc(rid)).status).toBe('cancelled');

    const res = await accept(teamA, rid, 't15a-leader');
    expect([res.status, res.body.error]).toEqual([409, 'ALREADY_DECIDED']);
    expect(await teamDoc(teamA)).toMatchObject({ memberCount: 1, openSeats: 3 });
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it('T15b: a stale pending request from someone already in a team is voided cleanly', async () => {
    const teamA = await makeTeam('t15s-a');
    const teamB = await makeTeam('t15s-b');
    expect((await env.join(teamB, 't15s-user')).status).toBe(201);
    // Simulate the write-skew window: a request that slipped in after the person joined.
    const stale = await env.db.collection('joinRequests').insertOne({
      hackathonId: 'h1',
      teamId: new ObjectId(teamA),
      userId: 't15s-user',
      status: 'pending',
      createdAt: new Date(),
    });
    const res = await accept(teamA, String(stale.insertedId), 't15s-a-leader');
    expect([res.status, res.body.error]).toEqual([409, 'REQUESTER_UNAVAILABLE']);
    expect((await requestDoc(String(stale.insertedId))).status).toBe('cancelled');
    expect(await teamDoc(teamA)).toMatchObject({ memberCount: 1, openSeats: 3 });
    expect(await memberRows('t15s-user')).toHaveLength(1);
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it("joining or creating a team voids the person's other pending requests", async () => {
    const a = await makeTeam('void-a');
    const b = await makeTeam('void-b');
    const c = await makeTeam('void-c');
    const ra = (await ask(a, 'void-u1')).body.requestId;
    const rb = (await ask(b, 'void-u1')).body.requestId;
    expect((await env.join(c, 'void-u1')).status).toBe(201);
    expect([(await requestDoc(ra)).status, (await requestDoc(rb)).status]).toEqual(['cancelled', 'cancelled']);

    const rc = (await ask(a, 'void-u2')).body.requestId;
    const own = await env.call('POST', '/hackathons/h1/teams', 'void-u2', { name: 'void-own' });
    expect(own.status).toBe(201);
    expect((await requestDoc(rc)).status).toBe('cancelled');
    expect(await checkInvariants(env.db)).toEqual([]);
  });

  it("T17: the last member leaving cancels the team's pending requests", async () => {
    const teamId = await makeTeam('t17r');
    const r1 = (await ask(teamId, 't17r-x')).body.requestId;
    const r2 = (await ask(teamId, 't17r-y')).body.requestId;
    expect((await env.call('POST', `/teams/${teamId}/leave`, 't17r-leader')).status).toBe(200);
    expect([(await requestDoc(r1)).status, (await requestDoc(r2)).status]).toEqual(['cancelled', 'cancelled']);
    expect(await checkInvariants(env.db)).toEqual([]); // includes I-6
  });

  it('T19: two requests accepted at once for one free seat: exactly one wins', async () => {
    for (let i = 0; i < 10; i++) {
      const p = `t19-${i}`;
      const teamId = await makeTeam(p, ['a', 'b']); // 3 of 4 seats: one left
      const r1 = (await ask(teamId, `${p}-x`)).body.requestId;
      const r2 = (await ask(teamId, `${p}-y`)).body.requestId;
      const results = await Promise.all([accept(teamId, r1, `${p}-leader`), accept(teamId, r2, `${p}-leader`)]);
      expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
      expect(results.find((r) => r.status === 409).body.error).toBe('TEAM_FULL');
      expect(await teamDoc(teamId)).toMatchObject({ memberCount: 4, openSeats: 0 });
      const states = [(await requestDoc(r1)).status, (await requestDoc(r2)).status].sort();
      expect(states).toEqual(['accepted', 'pending']); // the loser's request is untouched
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });

  it('accept racing the requester joining another team: exactly one succeeds', async () => {
    for (let i = 0; i < 10; i++) {
      const p = `acj-${i}`;
      const teamA = await makeTeam(`${p}-a`);
      const teamB = await makeTeam(`${p}-b`);
      const rid = (await ask(teamA, `${p}-user`)).body.requestId;
      const codeB = await env.codeOf(teamB);
      const [acc, join] = await Promise.all([
        accept(teamA, rid, `${p}-a-leader`),
        env.joinByCode(codeB, `${p}-user`),
      ]);
      expect([acc.status, join.status].filter((s) => s < 300)).toHaveLength(1);
      if (acc.status === 200) {
        expect(join.body.error).toBe('ALREADY_IN_TEAM');
      } else {
        expect(['ALREADY_DECIDED', 'REQUESTER_UNAVAILABLE']).toContain(acc.body.error);
        expect(join.status).toBe(201);
      }
      expect(await memberRows(`${p}-user`)).toHaveLength(1);
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });

  it('accept racing the leader leaving: leadership cannot be bypassed', async () => {
    for (let i = 0; i < 10; i++) {
      const p = `acl-${i}`;
      const teamId = await makeTeam(p, ['a']); // leader plus one member, who will inherit
      const rid = (await ask(teamId, `${p}-user`)).body.requestId;
      const [acc, left] = await Promise.all([
        accept(teamId, rid, `${p}-leader`),
        env.call('POST', `/teams/${teamId}/leave`, `${p}-leader`),
      ]);
      expect(left.status).toBe(200);
      expect([200, 403]).toContain(acc.status);
      if (acc.status === 200) {
        // The accept committed first: leader, a and the user were in; then the leader left.
        expect(await teamDoc(teamId)).toMatchObject({ leaderId: `${p}-a`, memberCount: 2, openSeats: 2 });
        expect(await memberRows(`${p}-user`)).toHaveLength(1);
      } else {
        // The leader left first, so the old leader no longer has the authority to accept.
        expect(acc.body.error).toBe('NOT_LEADER');
        expect(await teamDoc(teamId)).toMatchObject({ leaderId: `${p}-a`, memberCount: 1, openSeats: 3 });
        expect(await memberRows(`${p}-user`)).toHaveLength(0);
        expect((await requestDoc(rid)).status).toBe('pending');
      }
      expect(await checkInvariants(env.db)).toEqual([]);
    }
  });
});
