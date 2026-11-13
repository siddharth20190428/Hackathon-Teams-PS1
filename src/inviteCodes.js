import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so codes are hard to misread.
// 10 symbols x 5 bits = 50 bits of entropy.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const FORMAT = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export function newInviteCode() {
  const bytes = randomBytes(10);
  let code = '';
  // 256 is a multiple of 32, so `b & 31` is uniform over the alphabet.
  for (const b of bytes) code += ALPHABET[b & 31];
  return code;
}

// People type codes by hand: ignore case and spaces, and map the look-alikes.
export function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input.trim().toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0');
}

export const isValidCode = (code) => FORMAT.test(code);
