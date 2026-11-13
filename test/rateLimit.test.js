import { describe, it, expect } from 'vitest';
import { createRateLimiter } from '../src/rateLimit.js';

describe('rate limiter', () => {
  it('allows up to max per window, then blocks until the window ends', () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 10_000, max: 3, now: () => t });
    expect([1, 2, 3].map(() => rl.hit('a').allowed)).toEqual([true, true, true]);
    const blocked = rl.hit('a');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBe(10);
    t += 9_999;
    expect(rl.hit('a').allowed).toBe(false);
    t += 2;
    expect(rl.hit('a').allowed).toBe(true); // a new window
  });

  it('counts each key separately', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 1 });
    expect(rl.hit('a').allowed).toBe(true);
    expect(rl.hit('a').allowed).toBe(false);
    expect(rl.hit('b').allowed).toBe(true);
  });

  it('stays bounded when many distinct keys arrive', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 1, maxKeys: 50 });
    for (let i = 0; i < 500; i++) rl.hit(`k${i}`);
    expect(rl.hit('k499').allowed).toBe(false); // recent keys are still tracked
  });

  it('middleware answers 429 with Retry-After', () => {
    const rl = createRateLimiter({ windowMs: 5_000, max: 1 });
    const mw = rl.middleware(() => 'x');
    let nexts = 0;
    const res = {
      headers: {},
      set(k, v) { this.headers[k] = v; return this; },
      status(c) { this.code = c; return this; },
      json(b) { this.sent = b; return this; },
    };
    mw({}, res, () => nexts++);
    mw({}, res, () => nexts++);
    expect(nexts).toBe(1);
    expect(res.code).toBe(429);
    expect(res.sent).toEqual({ error: 'RATE_LIMITED' });
    expect(res.headers['Retry-After']).toBe('5');
  });
});
