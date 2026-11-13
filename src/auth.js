import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { httpError } from './errors.js';
import { getContext } from './context.js';

const scryptAsync = promisify(scrypt);

// ---------- passwords: scrypt with a random salt per password ----------
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P });
  return ['scrypt', N, R, P, salt.toString('base64'), hash.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, n, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(actual, expected);
}

// A real hash to compare against when the email is unknown, so "no such user" and
// "wrong password" take the same time.
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ??= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

// ---------- session tokens: payload.signature, both base64url ----------
const b64 = (buf) => Buffer.from(buf).toString('base64url');

export function createTokens(secret, { ttlSeconds = 7 * 24 * 3600, now = Date.now } = {}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('SESSION_SECRET must be a string of at least 32 characters');
  }
  const sign = (data) => createHmac('sha256', secret).update(data).digest();

  return {
    ttlSeconds,
    issue(userId, { ttl = ttlSeconds } = {}) {
      const payload = b64(JSON.stringify({ sub: userId, exp: Math.floor(now() / 1000) + ttl }));
      return `${payload}.${b64(sign(payload))}`;
    },
    // Returns the user id, or null for anything wrong: bad shape, bad signature, expired.
    verify(token) {
      if (typeof token !== 'string') return null;
      const [payload, signature, extra] = token.split('.');
      if (!payload || !signature || extra !== undefined) return null;
      const expected = sign(payload);
      const given = Buffer.from(signature, 'base64url');
      if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
      try {
        const { sub, exp } = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (typeof sub !== 'string' || !sub || typeof exp !== 'number') return null;
        return exp > Math.floor(now() / 1000) ? sub : null;
      } catch {
        return null;
      }
    },
  };
}

// ---------- reading the token off a request ----------
const COOKIE = 'session';

function readToken(req) {
  const auth = req.get('authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookies = req.get('cookie');
  if (cookies) {
    for (const part of cookies.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === COOKIE) return part.slice(i + 1).trim();
    }
  }
  return null;
}

// Stateless: the signature and expiry are checked, but no database read happens, so a
// request costs no extra query. Consequence: a session lives until it expires.
export function requireAuth(tokens) {
  return (req, res, next) => {
    const userId = tokens.verify(readToken(req));
    if (!userId) return res.status(401).json({ error: 'UNAUTHENTICATED' });
    req.userId = userId;
    const ctx = getContext();
    if (ctx) ctx.actorId = userId;
    next();
  };
}

export function setSessionCookie(res, tokens, userId, { secure }) {
  res.cookie(COOKIE, tokens.issue(userId), {
    httpOnly: true, // not readable by page scripts
    sameSite: 'lax', // not sent on cross-site POSTs
    secure,
    path: '/',
    maxAge: tokens.ttlSeconds * 1000,
  });
}

export const clearSessionCookie = (res, { secure }) =>
  res.clearCookie(COOKIE, { httpOnly: true, sameSite: 'lax', secure, path: '/' });

// ---------- accounts ----------
const publicUser = (u) => ({
  id: u._id,
  email: u.email,
  displayName: u.displayName,
  skills: u.skills ?? [],
  utcOffsetMinutes: u.utcOffsetMinutes ?? 0,
});

export async function registerUser(db, { email, password, displayName, skills = [], utcOffsetMinutes = 0 }) {
  const user = {
    _id: `u_${randomUUID()}`,
    email,
    passwordHash: await hashPassword(password),
    displayName,
    skills,
    utcOffsetMinutes,
    lookingForTeammates: true,
    createdAt: new Date(),
  };
  try {
    await db.collection('users').insertOne(user);
  } catch (err) {
    if (err?.code === 11000) throw httpError(409, 'EMAIL_TAKEN'); // the unique email index decides
    throw err;
  }
  return publicUser(user);
}

export async function loginUser(db, { email, password }) {
  const user = await db.collection('users').findOne({ email });
  if (!user?.passwordHash) {
    await burnPasswordCheck(password);
    throw httpError(401, 'INVALID_CREDENTIALS');
  }
  if (!(await verifyPassword(password, user.passwordHash))) throw httpError(401, 'INVALID_CREDENTIALS');
  return publicUser(user);
}

export async function getProfile(db, userId) {
  const user = await db.collection('users').findOne({ _id: userId });
  if (!user) throw httpError(404, 'NOT_FOUND'); // a valid session whose account no longer exists
  return publicUser(user);
}
