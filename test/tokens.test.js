import { describe, it, expect } from 'vitest';
import { createTokens, hashPassword, verifyPassword } from '../src/auth.js';

const SECRET = 'unit-secret-0123456789abcdef0123456789abcdef';

describe('session tokens', () => {
  it('a token verifies back to its user id', () => {
    const t = createTokens(SECRET);
    expect(t.verify(t.issue('u_1'))).toBe('u_1');
  });

  it('rejects a tampered payload, a tampered signature, another secret and garbage', () => {
    const t = createTokens(SECRET);
    const [payload, sig] = t.issue('u_1').split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'u_2', exp: 9_999_999_999 })).toString('base64url');
    expect(t.verify(`${forged}.${sig}`)).toBeNull();
    expect(t.verify(`${payload}.${sig.slice(0, -2)}xx`)).toBeNull();
    expect(createTokens('another-secret-0123456789abcdef012345').verify(t.issue('u_1'))).toBeNull();
    for (const bad of ['', 'abc', 'a.b.c', null, undefined, 42, {}]) expect(t.verify(bad)).toBeNull();
  });

  it('rejects an expired token', () => {
    let now = 1_000_000_000_000;
    const t = createTokens(SECRET, { ttlSeconds: 60, now: () => now });
    const token = t.issue('u_1');
    now += 59_000;
    expect(t.verify(token)).toBe('u_1');
    now += 2_000;
    expect(t.verify(token)).toBeNull();
  });

  it('refuses a short secret', () => {
    expect(() => createTokens('short')).toThrow();
  });
});

describe('passwords', () => {
  it('hashes with a random salt and verifies only the right password', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    expect(a).not.toBe(b); // different salts
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(a.includes('correct horse')).toBe(false);
    expect(await verifyPassword('correct horse battery', a)).toBe(true);
    expect(await verifyPassword('wrong password!!', a)).toBe(false);
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });
});
