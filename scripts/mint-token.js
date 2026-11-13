// Prints a session token for a user id. Used by the load test, which must not measure
// password hashing:  TOKEN=$(npm run -s token -- u1) LABEL=run npm run load
import { createTokens } from '../src/auth.js';

const userId = process.argv[2];
if (!userId) {
  console.error('usage: npm run -s token -- <userId>');
  process.exit(1);
}
if (!process.env.SESSION_SECRET) {
  console.error('SESSION_SECRET is not set (add it to .env)');
  process.exit(1);
}
process.stdout.write(createTokens(process.env.SESSION_SECRET).issue(userId) + '\n');
