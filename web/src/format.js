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
  TEAM_LOCKED: 'That team is closed to new members.',
  TEAM_TOO_SMALL: 'The team needs more members before it can be locked.',
  ALREADY_LOCKED: 'The team is already locked.',
  NOT_LOCKED: 'The team is not locked.',
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

// Places that use each offset, so people pick "India" instead of working out "UTC+5:30".
// Daylight saving moves a place to the next offset in summer, so some places appear twice.
const REGIONS = {
  '-720': 'Baker Island',
  '-660': 'American Samoa',
  '-600': 'Hawaii',
  '-570': 'Marquesas Islands',
  '-540': 'Alaska',
  '-480': 'Los Angeles, Vancouver',
  '-420': 'Denver, Phoenix, Los Angeles (summer)',
  '-360': 'Chicago, Mexico City, Denver (summer)',
  '-300': 'New York, Toronto, Bogota, Chicago (summer)',
  '-240': 'Halifax, Santiago, Caracas, New York (summer)',
  '-210': 'Newfoundland',
  '-180': 'Sao Paulo, Buenos Aires',
  '-120': 'South Georgia',
  '-60': 'Azores, Cape Verde',
  0: 'London, Lisbon, Accra, Reykjavik',
  60: 'Berlin, Paris, Lagos, London (summer)',
  120: 'Cairo, Johannesburg, Athens, Berlin (summer)',
  180: 'Moscow, Nairobi, Riyadh, Istanbul',
  210: 'Tehran',
  240: 'Dubai, Baku, Muscat',
  270: 'Kabul',
  300: 'Karachi, Tashkent',
  330: 'India, Sri Lanka',
  345: 'Nepal',
  360: 'Dhaka, Almaty',
  390: 'Myanmar',
  420: 'Bangkok, Jakarta, Hanoi',
  480: 'Singapore, Beijing, Perth, Manila',
  525: 'Eucla (Australia)',
  540: 'Tokyo, Seoul',
  570: 'Adelaide, Darwin',
  600: 'Sydney, Brisbane, Vladivostok',
  630: 'Lord Howe Island',
  660: 'Noumea, Solomon Islands',
  690: 'Norfolk Island',
  720: 'Auckland, Fiji',
  765: 'Chatham Islands',
  780: 'Tonga, Samoa',
  840: 'Kiritimati',
};
export const regionLabel = (minutes) => REGIONS[minutes] ?? '';
// First place only, for lists where space is short.
export const regionShort = (minutes) => regionLabel(minutes).split(',')[0].replace(/ \(summer\)$/, '');
export const tzLabel = (minutes) => {
  const region = regionLabel(minutes);
  return region ? `${utcLabel(minutes)} · ${region}` : utcLabel(minutes);
};
export const tzShort = (minutes) => {
  const region = regionShort(minutes);
  return region ? `${utcLabel(minutes)} · ${region}` : utcLabel(minutes);
};

// Offsets offered in the picker: the places above, plus the visitor's own and the saved one
// if they are unusual (seeded users can have any offset).
export function offsetOptions(detected, current = detected) {
  const list = Object.keys(REGIONS).map(Number);
  for (const extra of [detected, current]) if (!list.includes(extra)) list.push(extra);
  return list.sort((a, b) => a - b);
}

// What the browser reports, for example "Asia/Calcutta".
export const detectedZoneName = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone?.replace(/_/g, ' ') ?? '';
  } catch {
    return '';
  }
};

export const detectedOffset = () => {
  const minutes = -new Date().getTimezoneOffset();
  return Math.max(-720, Math.min(840, minutes));
};

export const formatDateTime = (iso) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

export const percent = (score) => Math.round(score * 100);

// One audit entry as a sentence. `names` maps user id to display name (the server sends it with
// the entries); the signed-in person reads as "You", a missing name as "A former member".
export function describeAudit(entry, names, meId) {
  const who = (id) => (!id ? 'The system' : id === meId ? 'You' : (names?.[id] ?? 'A former member'));
  const actor = who(entry.actorId);
  const target = who(entry.targetUserId);
  const s = entry.summary ?? {};
  switch (entry.action) {
    case 'TEAM_CREATED':
      return { icon: 'plus', text: `${actor} created the team` };
    case 'MEMBER_JOINED':
      return {
        icon: 'users',
        text: s.via === 'join_request' ? `${target} joined after ${actor === target ? 'the' : `${actor} accepted the`} request` : `${target} joined with the invite code`,
      };
    case 'MEMBER_LEFT':
      return { icon: 'door', text: `${target} left the team` };
    case 'MEMBER_REMOVED':
      return { icon: 'trash', text: `${actor} removed ${target}` };
    case 'LEADER_CHANGED':
      return { icon: 'crown', text: `${target} became the leader` };
    case 'INVITE_REGENERATED':
      return { icon: 'key', text: `${actor} generated a new invite code` };
    case 'JOIN_REQUESTED':
      return { icon: 'mail', text: `${target} asked to join` };
    case 'JOIN_REQUEST_DECLINED':
      return { icon: 'x', text: `${actor} declined the request from ${target}` };
    case 'JOIN_REQUEST_CANCELLED':
      return { icon: 'x', text: `The request from ${target} was cancelled` };
    case 'TEAM_LOCKED':
      return { icon: 'key', text: `${actor} locked the team` };
    case 'TEAM_UNLOCKED':
      return {
        icon: 'refresh',
        text: s.reason === 'below_minimum' ? 'The team unlocked itself because it fell below the minimum size' : `${actor} unlocked the team`,
      };
    case 'PROFILE_UPDATED':
      return { icon: 'user', text: `${actor} updated their profile${s.fields?.length ? ` (${s.fields.join(', ')})` : ''}` };
    default:
      return { icon: 'info', text: entry.action.toLowerCase().replaceAll('_', ' ') };
  }
}

