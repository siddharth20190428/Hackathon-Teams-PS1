export const SKILLS = ['frontend', 'backend', 'design', 'ml', 'devops', 'mobile', 'product'];
const SKILL_LABELS = { frontend: 'Frontend', backend: 'Backend', design: 'Design', ml: 'ML', devops: 'DevOps', mobile: 'Mobile', product: 'Product' };
export const skillLabel = (skill) => SKILL_LABELS[skill] ?? skill;

const MESSAGES = {
  TEAM_FULL: 'That team is full.',
  ALREADY_IN_TEAM: 'You are already in a team.',
  ALREADY_REQUESTED: 'You already asked this team.',
  INVALID_CODE: 'That invite code is not valid.',
  CODE_EXPIRED: 'That invite code has expired. Ask the leader for a new one.',
  NOT_LEADER: 'Only the team leader can do that.',
  NOT_MEMBER: 'You are not in that team.',
  NOT_FOUND: 'That no longer exists.',
  REQUESTER_UNAVAILABLE: 'That person has already joined another team.',
  INVALID_NAME: 'Please give the team a name.',
  EMAIL_TAKEN: 'That email already has an account. Try signing in.',
  INVALID_CREDENTIALS: 'Wrong email or password.',
  RATE_LIMITED: 'Too many attempts. Wait a minute and try again.',
  PAYLOAD_TOO_LARGE: 'That input is too large.',
  NETWORK: 'Cannot reach the server. Check your connection.',
};

// One readable sentence for any failed request.
export function messageFor(err) {
  if (err.code === 'VALIDATION_ERROR' && err.details?.length) {
    return err.details.map((d) => `${d.path}: ${d.message}`).join('; ');
  }
  if (err.code === 'RATE_LIMITED' && err.retryAfter) return `Too many attempts. Try again in ${err.retryAfter} s.`;
  return MESSAGES[err.code] ?? `Something went wrong (${err.code}).`;
}

export const initials = (name = '') =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? '')
    .join('') || '?';

// A stable colour per person, from a small set of classes (no inline styles).
export function tone(id = '') {
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash % 8;
}

export function utcLabel(minutes = 0) {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const m = abs % 60;
  return `UTC${sign}${Math.floor(abs / 60)}${m ? `:${String(m).padStart(2, '0')}` : ''}`;
}

// Offsets offered at sign-up: every half hour, plus the visitor's own if it is unusual.
export function offsetOptions(detected) {
  const list = [];
  for (let m = -720; m <= 840; m += 30) list.push(m);
  if (!list.includes(detected)) list.push(detected);
  return list.sort((a, b) => a - b);
}

export const detectedOffset = () => {
  const minutes = -new Date().getTimezoneOffset();
  return Math.max(-720, Math.min(840, minutes));
};

export const formatDateTime = (iso) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export const percent = (score) => Math.round(score * 100);
