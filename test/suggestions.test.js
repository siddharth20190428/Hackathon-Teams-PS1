import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { setup } from './helpers.js';
import {
  WEIGHTS,
  clockDistanceMinutes,
  medianOffset,
  teamProfile,
  scoreCandidate,
  rankCandidates,
} from '../src/suggestions.js';

describe('teammate scoring (no database)', () => {
  const team = { skills: ['backend'], utcOffsetMinutes: 330 };

  it('weights add up to 1', () => {
    expect(WEIGHTS.skills + WEIGHTS.timezone).toBeCloseTo(1, 10);
  });

  it('measures time-zone distance around the 24 hour clock', () => {
    expect(clockDistanceMinutes(330, 330)).toBe(0);
    expect(clockDistanceMinutes(0, 180)).toBe(180);
    expect(clockDistanceMinutes(840, -720)).toBe(120); // UTC+14 and UTC-12 are 2 h apart on the clock
    expect(clockDistanceMinutes(-480, 540)).toBe(1440 - 1020);
  });

  it('takes the median offset of a team and handles empty and even sizes', () => {
    expect(medianOffset([])).toBe(0);
    expect(medianOffset([60])).toBe(60);
    expect(medianOffset([0, 600, 60])).toBe(60);
    expect(medianOffset([0, 100])).toBe(50);
  });

  it('builds a team profile from its members', () => {
    expect(
      teamProfile([
        { skills: ['ml', 'backend'], utcOffsetMinutes: 0 },
        { skills: ['backend'], utcOffsetMinutes: 60 },
        { skills: [] },
      ]),
    ).toEqual({ skills: ['backend', 'ml'], utcOffsetMinutes: 0 });
  });

  it('scores new skills in the same time zone as a perfect match', () => {
    const s = scoreCandidate(team, { skills: ['frontend', 'design'], utcOffsetMinutes: 330 });
    expect(s.score).toBe(1);
    expect(s.skills).toEqual({ score: 1, adds: ['design', 'frontend'], overlaps: [] });
    expect(s.timezone.overlapHours).toBe(8);
    expect(s.reasons[0]).toBe('Adds design, frontend, which your team does not have yet');
    expect(s.reasons[1]).toBe('0 h apart: 8 of 8 working hours overlap');
  });

  it('gives only the time-zone share to someone who repeats the team\'s skills', () => {
    const s = scoreCandidate(team, { skills: ['backend'], utcOffsetMinutes: 330 });
    expect(s.score).toBe(0.4);
    expect(s.skills.overlaps).toEqual(['backend']);
    expect(s.reasons[0]).toBe('Only has skills your team already covers');
  });

  it('scores half new skills as half the skill share', () => {
    const s = scoreCandidate(team, { skills: ['backend', 'ml'], utcOffsetMinutes: 330 });
    expect(s.skills.score).toBe(0.5);
    expect(s.score).toBe(0.7); // 0.6 x 0.5 + 0.4 x 1
  });

  it('reduces the time-zone share as the distance grows, and ends at zero after 8 hours', () => {
    const at = (offset) => scoreCandidate(team, { skills: ['ml'], utcOffsetMinutes: 330 + offset }).timezone;
    expect(at(180).overlapHours).toBe(5);
    expect(at(180).score).toBe(0.625);
    expect(at(480).overlapHours).toBe(0);
    expect(at(600).score).toBe(0);
    expect(scoreCandidate(team, { skills: ['ml'], utcOffsetMinutes: 330 + 180 }).reasons[1]).toBe(
      '3 h apart: 5 of 8 working hours overlap',
    );
  });

  it('handles a candidate with no skills and no offset', () => {
    const s = scoreCandidate(team, {});
    expect(s.skills.score).toBe(0);
    expect(s.reasons[0]).toBe('Lists no skills');
    expect(s.timezone.candidateOffsetMinutes).toBe(0);
  });

  it('ranks by score, breaks ties the same way every time, and respects the limit', () => {
    const people = [
      { _id: 'c', skills: ['ml'], utcOffsetMinutes: 330 },
      { _id: 'a', skills: ['ml'], utcOffsetMinutes: 330 }, // same as c: the id decides
      { _id: 'b', skills: ['ml'], utcOffsetMinutes: 360 }, // a little further away
      { _id: 'd', skills: ['backend'], utcOffsetMinutes: 330 },
    ];
    const ids = (list) => list.map((r) => r.user._id);
    expect(ids(rankCandidates(team, people, 10))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(rankCandidates(team, [...people].reverse(), 10))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(rankCandidates(team, people, 2))).toEqual(['a', 'c']);
  });
});

describe('suggestions and the people list over HTTP', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
    const person = (id, skills, utcOffsetMinutes, createdAt) => ({
      _id: id,
      email: `${id}@example.test`,
      passwordHash: 'must-never-be-shown',
      displayName: id[0].toUpperCase() + id.slice(1),
      skills,
      utcOffsetMinutes,
      createdAt: new Date(createdAt),
    });
    await env.db.collection('users').insertMany([
      person('alice', ['backend'], 330, 1000),
      person('bea', ['frontend', 'design'], 330, 2000),
      person('cal', ['backend'], 330, 3000),
      person('dev', ['ml'], -480, 4000),
      person('eli', ['frontend'], 360, 5000),
      person('fred', ['ml', 'design'], 330, 6000),
    ]);
    const mine = await env.call('POST', '/hackathons/h1/teams', 'alice', { name: 'Alice Team' });
    expect(mine.status).toBe(201);
    env.aliceTeam = mine.body;
    // Fred leads another team, so he is not a free person.
    expect((await env.call('POST', '/hackathons/h1/teams', 'fred', { name: 'Fred Team' })).status).toBe(201);
  });
  afterAll(async () => {
    await env.teardown();
  });

  const suggestions = (teamId, user, query = '') => env.call('GET', `/teams/${teamId}/suggestions${query}`, user);
  const ids = (res) => res.body.suggestions.map((s) => s.user._id);

  it('T24: ranks free people by complementary skills and time zone, with the reasons', async () => {
    const res = await suggestions(env.aliceTeam._id, 'alice');
    expect(res.status).toBe(200);
    expect(ids(res)).toEqual(['bea', 'eli', 'dev', 'cal']);
    expect(res.body.suggestions.map((s) => s.score)).toEqual([1, 0.975, 0.6, 0.4]);
    expect(res.body.team).toEqual({ skills: ['backend'], utcOffsetMinutes: 330 });
    expect(res.body.method.weights).toEqual({ skills: 0.6, timezone: 0.4 });

    const bea = res.body.suggestions[0];
    expect(bea.skills.adds).toEqual(['design', 'frontend']);
    expect(bea.reasons).toEqual([
      'Adds design, frontend, which your team does not have yet',
      '0 h apart: 8 of 8 working hours overlap',
    ]);
    const dev = res.body.suggestions[2];
    expect(dev.timezone.overlapHours).toBe(0); // 10.5 h apart on the clock
    expect(dev.reasons[1]).toBe('10.5 h apart: 0 of 8 working hours overlap');
  });

  it('leaves out the caller\'s own team and people who are already in a team, and never shows private fields', async () => {
    const res = await suggestions(env.aliceTeam._id, 'alice');
    expect(ids(res)).not.toContain('alice');
    expect(ids(res)).not.toContain('fred');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('example.test');
    expect(text).not.toContain('must-never-be-shown');
    expect(Object.keys(res.body.suggestions[0].user).sort()).toEqual(['_id', 'displayName', 'skills', 'utcOffsetMinutes']);
  });

  it('only members of the team can ask, and the session is required', async () => {
    expect((await suggestions(env.aliceTeam._id, 'cal')).status).toBe(403);
    expect((await suggestions('000000000000000000000000', 'alice')).status).toBe(404);
    expect((await suggestions('not-an-id', 'alice')).status).toBe(404);
    expect((await env.raw('GET', `/teams/${env.aliceTeam._id}/suggestions`)).status).toBe(401);
  });

  it('limits the number of suggestions', async () => {
    expect(ids(await suggestions(env.aliceTeam._id, 'alice', '?limit=2'))).toEqual(['bea', 'eli']);
    expect(ids(await suggestions(env.aliceTeam._id, 'alice', '')).length).toBe(4); // default
  });

  it('the people list shows free people only, newest first, without private fields', async () => {
    const res = await env.call('GET', '/hackathons/h1/people', 'alice');
    expect(res.status).toBe(200);
    expect(res.body.people.map((p) => p._id)).toEqual(['eli', 'dev', 'cal', 'bea']);
    expect(Object.keys(res.body.people[0]).sort()).toEqual(['_id', 'displayName', 'skills', 'utcOffsetMinutes']);
    expect(JSON.stringify(res.body)).not.toContain('example.test');
    expect((await env.raw('GET', '/hackathons/h1/people')).status).toBe(401);
  });

  it('once someone joins, they leave the people list at once and the team\'s skills change the ranking', async () => {
    await env.call('GET', '/hackathons/h1/people', 'alice'); // warm the cache
    const joined = await env.joinByCode(env.aliceTeam.inviteCode, 'bea');
    expect(joined.status).toBe(201);

    const people = await env.call('GET', '/hackathons/h1/people', 'alice');
    expect(people.body.people.map((p) => p._id)).not.toContain('bea');

    const res = await suggestions(env.aliceTeam._id, 'alice');
    expect(res.body.team.skills).toEqual(['backend', 'design', 'frontend']);
    expect(ids(res)).toEqual(['dev', 'cal', 'eli']); // eli now repeats a skill the team has
    expect(res.body.suggestions.find((s) => s.user._id === 'eli').skills.score).toBe(0);
    expect((await suggestions(env.aliceTeam._id, 'bea')).status).toBe(200); // members can ask too
  });

  it('a new account shows up in the people list at once', async () => {
    await env.call('GET', '/hackathons/h1/people', 'alice'); // warm the cache
    const reg = await env.raw('POST', '/auth/register', {
      body: { email: 'newcomer@example.test', password: 'correct horse battery', displayName: 'Newcomer', skills: ['devops'] },
    });
    expect(reg.status).toBe(201);
    const people = await env.call('GET', '/hackathons/h1/people', 'alice');
    expect(people.body.people[0].displayName).toBe('Newcomer'); // newest first
  });
});
