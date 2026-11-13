import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { setup } from './helpers.js';
import { createBoardEvents } from '../src/boardEvents.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(10);
  }
  return false;
};

// A minimal response/request pair, enough for the hub.
function fakeStream({ writableLength = 0 } = {}) {
  const req = new EventEmitter();
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = writableLength;
  res.destroyed = false;
  res.status = () => res;
  res.set = () => res;
  res.flushHeaders = () => {};
  res.write = (c) => res.chunks.push(c);
  res.end = () => {};
  res.destroy = () => {
    res.destroyed = true;
  };
  return { req, res };
}

describe('board events hub (no database)', () => {
  it('coalesces a burst of publishes into one event carrying the latest version', async () => {
    const hub = createBoardEvents({ coalesceMs: 20 });
    const { req, res } = fakeStream();
    expect(hub.subscribe(req, res, 'u1').ok).toBe(true);
    for (let i = 0; i < 50; i++) hub.publish();
    await sleep(60);
    const events = res.chunks.filter((c) => c.includes('event: board'));
    expect(events).toHaveLength(1);
    expect(events[0]).toContain('"version":50');
    hub.close();
  });

  it('refuses streams beyond the total and per-user caps, and frees a slot on close', () => {
    const hub = createBoardEvents({ maxStreams: 3, maxPerUser: 2 });
    const open = (user) => {
      const s = fakeStream();
      return { ...s, result: hub.subscribe(s.req, s.res, user) };
    };
    const a1 = open('a');
    open('a');
    expect(open('a').result).toEqual({ ok: false, status: 429, error: 'TOO_MANY_STREAMS_FOR_USER' });
    open('b');
    expect(open('c').result).toEqual({ ok: false, status: 503, error: 'TOO_MANY_STREAMS' });
    a1.res.emit('close');
    expect(hub.size()).toBe(2);
    expect(open('c').result.ok).toBe(true);
    hub.close();
  });

  it('drops a client that is not reading instead of buffering for it', async () => {
    const hub = createBoardEvents({ coalesceMs: 5, maxBufferedBytes: 1000 });
    const slow = fakeStream({ writableLength: 5000 });
    const fast = fakeStream();
    hub.subscribe(slow.req, slow.res, 'slow');
    hub.subscribe(fast.req, fast.res, 'fast');
    hub.publish();
    await sleep(30);
    expect(slow.res.destroyed).toBe(true);
    expect(hub.size()).toBe(1);
    expect(fast.res.chunks.some((c) => c.includes('event: board'))).toBe(true);
    hub.close();
  });
});

// Opens the stream with fetch and collects parsed events.
async function openStream(env, userId, hid = 'h1') {
  const ac = new AbortController();
  const res = await fetch(`${env.base}/hackathons/${hid}/board/events`, {
    headers: { authorization: `Bearer ${env.tokenFor(userId)}` },
    signal: ac.signal,
  });
  const events = [];
  if (res.status === 200) {
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for await (const chunk of res.body) {
          buffer += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const name = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (name) events.push({ name, data: JSON.parse(data) });
          }
        }
      } catch {
        // aborted by the test
      }
    })();
  }
  return { res, events, close: () => ac.abort(), boards: () => events.filter((e) => e.name === 'board') };
}

describe('board events over HTTP', () => {
  let env;
  let hub;
  beforeAll(async () => {
    hub = createBoardEvents({ coalesceMs: 30, maxPerUser: 2 });
    env = await setup({ boardEvents: hub });
  });
  afterAll(async () => {
    hub.close();
    await env.teardown();
  });

  it('T25: needs a session', async () => {
    const res = await env.raw('GET', '/hackathons/h1/board/events');
    expect(res.status).toBe(401);
  });

  it('opens an event stream that starts with a ready event', async () => {
    const s = await openStream(env, 'watcher-1');
    expect(s.res.status).toBe(200);
    expect(s.res.headers.get('content-type')).toContain('text/event-stream');
    expect(s.res.headers.get('cache-control')).toContain('no-cache');
    expect(await until(() => s.events.some((e) => e.name === 'ready'))).toBe(true);
    s.close();
  });

  it('T25: a new team triggers an event, and reading the board right after the event shows it', async () => {
    const s = await openStream(env, 'watcher-2');
    await until(() => s.events.length > 0);
    const before = s.boards().length;
    const created = await env.call('POST', '/hackathons/h1/teams', 'maker-1', { name: 'live-team' });
    expect(created.status).toBe(201);
    expect(await until(() => s.boards().length > before)).toBe(true);
    const board = await env.call('GET', '/hackathons/h1/board', 'watcher-2');
    expect(board.body.teams.map((t) => t.name)).toContain('live-team');
    s.close();
  });

  it('a burst of writes sends far fewer events than writes, and the board then shows all of them', async () => {
    const s = await openStream(env, 'watcher-3');
    await until(() => s.events.length > 0);
    const before = s.boards().length;
    const writes = Array.from({ length: 15 }, (_, i) =>
      env.call('POST', '/hackathons/h1/teams', `burst-${i}`, { name: `burst-team-${i}` }),
    );
    expect((await Promise.all(writes)).every((r) => r.status === 201)).toBe(true);
    await sleep(150); // let the last window flush
    const got = s.boards().length - before;
    expect(got).toBeGreaterThanOrEqual(1);
    expect(got).toBeLessThan(15);
    const versions = s.boards().map((e) => e.data.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b)); // never goes backwards
    const board = await env.call('GET', '/hackathons/h1/board', 'watcher-3');
    const names = board.body.teams.map((t) => t.name);
    for (let i = 0; i < 15; i++) expect(names).toContain(`burst-team-${i}`);
    s.close();
  });

  it('a failed write and a join request do not wake the board', async () => {
    const s = await openStream(env, 'watcher-4');
    await until(() => s.events.length > 0);
    await sleep(100); // let events from earlier tests drain
    const before = s.boards().length;
    const bad = await env.call('POST', '/hackathons/h1/teams', 'maker-bad', { name: '' });
    expect(bad.status).toBe(400);
    await sleep(120);
    expect(s.boards().length).toBe(before);
    s.close();
  });

  it('limits streams per user and frees the slot when one closes', async () => {
    const a = await openStream(env, 'greedy');
    const b = await openStream(env, 'greedy');
    expect([a.res.status, b.res.status]).toEqual([200, 200]);
    const c = await openStream(env, 'greedy');
    expect(c.res.status).toBe(429);
    a.close();
    expect(await until(async () => (await openStream(env, 'greedy')).res.status === 200)).toBe(true);
    b.close();
  });
});
