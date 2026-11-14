// Teammate scoring. Pure functions, no database, so the rules can be read and tested alone.
//
// A candidate is scored 0 to 1 for a team:
//   score = 0.6 x skill complement + 0.4 x time-zone overlap
//
// - Skill complement: the share of the candidate's skills that the team does not have yet.
//   Someone whose every skill is new to the team scores 1; someone who only repeats skills
//   the team already has scores 0.
// - Time-zone overlap: everyone is assumed to work 09:00 to 17:00 local time (8 hours). The
//   team's offset is the median of its members' offsets. The overlap is 8 hours minus the
//   distance between the two offsets on the 24 hour clock, never below 0, divided by 8.
//
// Every score comes with its parts and a plain-language reason for each, so a leader can see
// why someone was ranked where they were.
export const WEIGHTS = { skills: 0.6, timezone: 0.4 };
export const WORKDAY_HOURS = 8;

const round = (n, digits = 3) => Math.round(n * 10 ** digits) / 10 ** digits;
const hours = (minutes) => round(minutes / 60, 1);

// Offsets are minutes east of UTC. Distance is measured around the clock, so +14:00 and
// -10:00 are 0 hours apart.
export function clockDistanceMinutes(a, b) {
  const d = Math.abs(a - b) % 1440;
  return Math.min(d, 1440 - d);
}

export function medianOffset(offsets) {
  if (!offsets.length) return 0;
  const sorted = [...offsets].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

// members: [{ skills, utcOffsetMinutes }]
export function teamProfile(members) {
  return {
    skills: [...new Set(members.flatMap((m) => m.skills ?? []))].sort(),
    utcOffsetMinutes: medianOffset(members.map((m) => m.utcOffsetMinutes ?? 0)),
  };
}

export function scoreCandidate(team, candidate) {
  const have = new Set(team.skills);
  const skills = [...new Set(candidate.skills ?? [])];
  const adds = skills.filter((s) => !have.has(s)).sort();
  const overlaps = skills.filter((s) => have.has(s)).sort();
  const skillScore = skills.length ? adds.length / skills.length : 0;

  const candidateOffset = candidate.utcOffsetMinutes ?? 0;
  const apart = clockDistanceMinutes(team.utcOffsetMinutes, candidateOffset);
  const overlapHours = Math.max(0, WORKDAY_HOURS - apart / 60);
  const timezoneScore = overlapHours / WORKDAY_HOURS;

  const skillReason = adds.length
    ? `Adds ${adds.join(', ')}, which your team does not have yet`
    : skills.length
      ? 'Only has skills your team already covers'
      : 'Lists no skills';
  const zoneReason = `${hours(apart)} h apart: ${round(overlapHours, 1)} of ${WORKDAY_HOURS} working hours overlap`;

  return {
    score: round(WEIGHTS.skills * skillScore + WEIGHTS.timezone * timezoneScore),
    skills: { score: round(skillScore), adds, overlaps },
    timezone: {
      score: round(timezoneScore),
      differenceHours: round(apart / 60, 2),
      overlapHours: round(overlapHours, 2),
      teamOffsetMinutes: team.utcOffsetMinutes,
      candidateOffsetMinutes: candidateOffset,
    },
    reasons: [skillReason, zoneReason],
  };
}

// Highest score first. Ties are broken the same way every time: more new skills, then the
// smaller time difference, then the id.
export function rankCandidates(team, candidates, limit = 10) {
  return candidates
    .map((user) => ({ user, ...scoreCandidate(team, user) }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.skills.adds.length - a.skills.adds.length ||
        a.timezone.differenceHours - b.timezone.differenceHours ||
        (a.user._id < b.user._id ? -1 : a.user._id > b.user._id ? 1 : 0),
    )
    .slice(0, limit);
}

export const METHOD = {
  weights: WEIGHTS,
  workdayHours: WORKDAY_HOURS,
  description:
    'score = 0.6 x skill complement + 0.4 x time-zone overlap. Skill complement is the share of the ' +
    "candidate's skills the team does not have. Time-zone overlap is the overlap of 8 working hours " +
    "(09:00 to 17:00 local) between the candidate and the team's median offset.",
};
