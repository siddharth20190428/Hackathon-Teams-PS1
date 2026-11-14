import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { setup } from './helpers.js';

// The board and people lists are rendered once per cache fill: JSON, gzip and ETag together.
describe('board and people responses: gzip and ETag', () => {
  let env;
  beforeAll(async () => {
    env = await setup();
    // Enough teams and people for the bodies to be worth compressing (512 bytes or more).
    for (let i = 0; i < 12; i++) {
      await env.call('POST', '/hackathons/h1/teams', `cz-lead-${i}`, { name: `Compression test team ${i}` });
    }
    await env.db.collection('users').insertMany(
      Array.from({ length: 12 }, (_, i) => ({
        _id: `cz-person-${i}`,
        email: `cz${i}@example.test`,
        displayName: `Person number ${i}`,
        skills: ['frontend', 'backend'],
        utcOffsetMinutes: 330,
        createdAt: new Date(),
      })),
    );
  });
  afterAll(async () => {
    await env.teardown();
  });

  // node:http does not decode anything, so the test sees exactly what is on the wire.
  const get = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      http
        .get(env.base + path, { headers: { authorization: `Bearer ${env.tokenFor('cz-viewer')}`, ...headers } }, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        })
        .on('error', reject);
    });

  for (const path of ['/hackathons/h1/board', '/hackathons/h1/people']) {
    describe(path, () => {
      it('is gzip when the client accepts it, plain when it does not, and says so with Vary', async () => {
        const zipped = await get(path, { 'accept-encoding': 'gzip' });
        const plain = await get(path, { 'accept-encoding': 'identity' });
        const unspecified = await get(path);
        expect(zipped.status).toBe(200);
        expect(zipped.headers['content-encoding']).toBe('gzip');
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(unspecified.headers['content-encoding']).toBeUndefined();
        expect(zipped.headers.vary).toMatch(/Accept-Encoding/i);
        expect(zipped.headers['content-type']).toMatch(/application\/json/);
        expect(zipped.headers['cache-control']).toBe('private, no-cache');
        expect(zipped.body.length).toBeLessThan(plain.body.length / 2);
        expect(gunzipSync(zipped.body).equals(plain.body)).toBe(true);
        expect(JSON.parse(plain.body.toString())).toBeTypeOf('object');
      });

      it('has a stable ETag, and If-None-Match gets a 304 with no body in either encoding', async () => {
        const first = await get(path, { 'accept-encoding': 'gzip' });
        const second = await get(path, { 'accept-encoding': 'identity' });
        expect(first.headers.etag).toMatch(/^W\/"/);
        expect(second.headers.etag).toBe(first.headers.etag);
        for (const enc of ['gzip', 'identity']) {
          const again = await get(path, { 'accept-encoding': enc, 'if-none-match': first.headers.etag });
          expect([enc, again.status, again.body.length]).toEqual([enc, 304, 0]);
        }
      });

      it('a write changes the ETag, so a stale one gets a full answer', async () => {
        const before = await get(path);
        await env.call('POST', '/hackathons/h1/teams', `cz-after-${path.length}`, { name: `Changes the board ${path.length}` });
        // Registration is what publishes for people; creating a team changes the board. Either way
        // the stale ETag must not be answered with 304 once the data under it has changed.
        await env.call('POST', '/auth/register', undefined, { email: `etag${path.length}@example.test`, password: 'password123', displayName: 'Etag Person' });
        const after = await get(path, { 'if-none-match': before.headers.etag });
        expect(after.status).toBe(200);
        expect(after.headers.etag).not.toBe(before.headers.etag);
      });
    });
  }
});
