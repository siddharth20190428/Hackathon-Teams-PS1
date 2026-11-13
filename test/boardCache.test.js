import { describe, it, expect } from 'vitest';
import { createBoardCache } from '../src/boardCache.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

describe('board cache', () => {
  it('shares one load between concurrent misses', async () => {
    const cache = createBoardCache();
    let loads = 0;
    const load = async () => {
      loads++;
      await new Promise((r) => setTimeout(r, 10));
      return 'v1';
    };
    const results = await Promise.all(Array.from({ length: 100 }, () => cache.get('h1', load)));
    expect(loads).toBe(1);
    expect(new Set(results)).toEqual(new Set(['v1']));
  });

  it('serves from memory within the TTL and reloads after it', async () => {
    let t = 1000;
    const cache = createBoardCache({ ttlMs: 2000, now: () => t });
    let loads = 0;
    const load = async () => `v${++loads}`;
    expect(await cache.get('h1', load)).toBe('v1');
    t += 1999;
    expect(await cache.get('h1', load)).toBe('v1');
    t += 2;
    expect(await cache.get('h1', load)).toBe('v2');
    expect(loads).toBe(2);
  });

  it('invalidate drops cached values', async () => {
    const cache = createBoardCache();
    let loads = 0;
    const load = async () => `v${++loads}`;
    expect(await cache.get('h1', load)).toBe('v1');
    cache.invalidate();
    expect(await cache.get('h1', load)).toBe('v2');
  });

  it('a load that was running during an invalidation is not stored', async () => {
    const cache = createBoardCache();
    const first = deferred();
    let calls = 0;
    const load = () => {
      calls++;
      return calls === 1 ? first.promise : Promise.resolve('fresh');
    };
    const stale = cache.get('h1', load); // load 1 starts and stays pending
    cache.invalidate(); // a write happens
    expect(await cache.get('h1', load)).toBe('fresh'); // a new load, not joined to the old one
    first.resolve('stale');
    expect(await stale).toBe('stale'); // the old caller still gets its own answer
    expect(await cache.get('h1', load)).toBe('fresh'); // the stale answer was never stored
    expect(calls).toBe(2);
  });

  it('does not cache errors', async () => {
    const cache = createBoardCache();
    let calls = 0;
    const load = async () => {
      calls++;
      if (calls === 1) throw new Error('boom');
      return 'ok';
    };
    await expect(cache.get('h1', load)).rejects.toThrow('boom');
    expect(await cache.get('h1', load)).toBe('ok');
    expect(calls).toBe(2);
  });

  it('is bypassed when the TTL is 0', async () => {
    const cache = createBoardCache({ ttlMs: 0 });
    let loads = 0;
    const load = async () => ++loads;
    await cache.get('h1', load);
    await cache.get('h1', load);
    await cache.get('h1', load);
    expect(loads).toBe(3);
  });

  it('keeps at most maxEntries keys', async () => {
    const cache = createBoardCache({ maxEntries: 2 });
    const loads = { a: 0, b: 0, c: 0 };
    const loader = (k) => async () => ++loads[k];
    await cache.get('a', loader('a'));
    await cache.get('b', loader('b'));
    await cache.get('c', loader('c')); // evicts 'a', the oldest
    await cache.get('c', loader('c')); // still cached
    await cache.get('a', loader('a')); // reloaded
    expect(loads).toEqual({ a: 2, b: 1, c: 1 });
  });
});
