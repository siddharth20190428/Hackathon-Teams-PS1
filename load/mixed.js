// Write-path load test: board reads mixed with joins (half of them fighting for a few hot
// seats) and team creation. Every user acts once per iteration, so writes hit the database
// for real. Prepare with scripts/load-fixtures.js; check afterwards with scripts/verify-load.js.
//
// Start the server with RATE_LIMITS=off, otherwise this measures the rate limiter.
//   RATE_LIMITS=off npm start
//   LABEL=w1 k6 run load/mixed.js
import http from 'k6/http';
import { sleep } from 'k6';
import exec from 'k6/execution';
import { SharedArray } from 'k6/data';
import { Counter, Rate } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const READ_PCT = Number(__ENV.READ_PCT || 70);
const JOIN_PCT = Number(__ENV.JOIN_PCT || 25); // the rest creates teams
const THINK_MS = Number(__ENV.THINK_MS || 0); // mean pause between a user's actions; 0 = stress test
const HOT_SHARE = Number(__ENV.HOT_SHARE || 0.5); // share of joins aimed at the hot teams

const F = new SharedArray('fixtures', () => [JSON.parse(open('./fixtures.json'))])[0];
const H = F.hackathonId;

const serverErrors = new Rate('server_errors');
const outcome = {
  join_201: new Counter('join_201'),
  join_409: new Counter('join_409'),
  join_404: new Counter('join_404'),
  join_429: new Counter('join_429'),
  join_other: new Counter('join_other'),
  create_201: new Counter('create_201'),
  create_other: new Counter('create_other'),
};

export const options = {
  scenarios: {
    mixed: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 100),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    'http_req_duration{op:board}': ['p(95)<200'],
    'http_req_duration{op:join}': ['p(95)<200'],
    'http_req_duration{op:create}': ['p(95)<200'],
    server_errors: ['rate==0'],
    join_429: ['count==0'], // anything else means the server was started with rate limits on
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

const pickFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];

function headers(user) {
  const key = `k6-${exec.vu.idInTest}-${exec.vu.iterationInInstance}-${Math.random().toString(36).slice(2, 10)}`;
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${user.token}`,
    'idempotency-key': key,
  };
}

export default function () {
  const roll = Math.random() * 100;
  // A fresh user for every write, so one user's joins do not all fail as "already in a team".
  const user = F.users[exec.scenario.iterationInTest % F.users.length];

  if (roll < READ_PCT) {
    const res = http.get(`${BASE}/hackathons/${H}/board`, {
      headers: { authorization: `Bearer ${user.token}` },
      tags: { op: 'board' },
    });
    serverErrors.add(res.status >= 500 || res.status === 0);
  } else if (roll < READ_PCT + JOIN_PCT) {
    const code = Math.random() < HOT_SHARE && F.hot.length ? pickFrom(F.hot).code : pickFrom(F.warm);
    const res = http.post(`${BASE}/hackathons/${H}/join-by-code`, JSON.stringify({ code }), {
      headers: headers(user),
      tags: { op: 'join' },
    });
    serverErrors.add(res.status >= 500 || res.status === 0);
    (outcome[`join_${res.status}`] ?? outcome.join_other).add(1);
  } else {
    const res = http.post(
      `${BASE}/hackathons/${H}/teams`,
      JSON.stringify({ name: `load-${exec.vu.idInTest}-${exec.vu.iterationInInstance}` }),
      { headers: headers(user), tags: { op: 'create' } },
    );
    serverErrors.add(res.status >= 500 || res.status === 0);
    (res.status === 201 ? outcome.create_201 : outcome.create_other).add(1);
  }
  if (THINK_MS > 0) sleep((THINK_MS * (0.5 + Math.random())) / 1000);
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : String(n));
const vals = (m) => (m && (m.values ?? m)) || {};
const count = (name, data) => vals(data.metrics[name]).count ?? 0;

export function handleSummary(data) {
  const label = __ENV.LABEL || 'mixed';
  const line = (op) => {
    const d = vals(data.metrics[`http_req_duration{op:${op}}`]);
    return `${op.padEnd(7)} avg=${fmt(d.avg)} med=${fmt(d.med)} p95=${fmt(d['p(95)'])} p99=${fmt(d['p(99)'])} max=${fmt(d.max)}`;
  };
  const r = vals(data.metrics.http_reqs);
  const text =
    [
      `label:        ${label}  (read ${READ_PCT}% / join ${JOIN_PCT}% / create ${100 - READ_PCT - JOIN_PCT}%, hot share ${HOT_SHARE}, think ${THINK_MS} ms)`,
      `requests:     ${r.count}  (${fmt(r.rate)} req/s)`,
      `latency (ms):`,
      `  ${line('board')}`,
      `  ${line('join')}`,
      `  ${line('create')}`,
      `joins:        201=${count('join_201', data)} 409=${count('join_409', data)} 404=${count('join_404', data)} 429=${count('join_429', data)} other=${count('join_other', data)}`,
      `creates:      201=${count('create_201', data)} other=${count('create_other', data)}`,
      `server errors: ${fmt(vals(data.metrics.server_errors).rate * 100)}%`,
    ].join('\n') + '\n';
  return { stdout: text, [`reports/${label}.json`]: JSON.stringify(data, null, 2) };
}
