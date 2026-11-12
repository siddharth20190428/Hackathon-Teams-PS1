import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ObjectId } from 'mongodb';
import { setup } from './helpers.js';
import { checkInvariants } from '../src/invariants.js';

const ROUNDS = Number(process.env.RACE_ROUNDS ?? 5);
const CONTENDERS = 50;

describe('T1: 50 users race for the last seat (AC-1)', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
  });
  afterAll(async () => {
    await env.teardown();
  });

  it(`exactly one winner, repeated ${ROUNDS} times`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const p = `r${round}`;
      const created = await env.call('POST', '/hackathons/h1/teams', `${p}-leader`, {
        name: `team-${round}`,
      });
      expect(created.status).toBe(201);
      const teamId = created.body._id;

      for (const m of ['m1', 'm2']) {
        const joined = await env.call('POST', `/teams/${teamId}/join`, `${p}-${m}`);
        expect(joined.status).toBe(201);
      }

      // 3 of 4 seats are taken, so exactly one seat is left.
      const results = await Promise.all(
        Array.from({ length: CONTENDERS }, (_, i) =>
          env.call('POST', `/teams/${teamId}/join`, `${p}-c${i}`),
        ),
      );
      const wins = results.filter((r) => r.status === 201).length;
      const full = results.filter((r) => r.status === 409 && r.body?.error === 'TEAM_FULL').length;
      expect({ wins, full }).toEqual({ wins: 1, full: CONTENDERS - 1 });

      const rows = await env.db
        .collection('memberships')
        .countDocuments({ teamId: new ObjectId(teamId) });
      expect(rows).toBe(4);
    }
    expect(await checkInvariants(env.db)).toEqual([]);
  });
});
