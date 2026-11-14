import http from 'k6/http';
import { check, sleep } from 'k6';
import exec from 'k6/execution';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const HACKATHON = __ENV.HACKATHON_ID || 'h1';
const TOKEN = __ENV.TOKEN;
// Mean pause between one user's reads. 0 (default) is a stress test: every user fires again at
// once. With THINK_MS=1000, 100 users make about 100 requests a second, like 100 people with
// the board open and refreshing about once a second.
const THINK_MS = Number(__ENV.THINK_MS || 0);
// By default all virtual users fire their first request at the same instant, which is a
// stampede of VUS requests queued behind each other (a few percent of the whole run, enough to
// move p95). STAGGER_MS=1000 makes each user's first request wait a random 0 to 1000 ms, so
// users arrive over a second, as real ones do. Report both numbers.
const STAGGER_MS = Number(__ENV.STAGGER_MS || 0);
if (!TOKEN) throw new Error('set TOKEN, e.g. TOKEN=$(npm run -s token -- u1) npm run load');

export const options = {
  scenarios: {
    board: {
      executor: 'constant-vus',
      vus: Number(__ENV.VUS || 100),
      duration: __ENV.DURATION || '30s',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200'],
    http_req_failed: ['rate<0.01'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export default function () {
  if (STAGGER_MS > 0 && exec.vu.iterationInScenario === 0) sleep((Math.random() * STAGGER_MS) / 1000);
  const res = http.get(`${BASE}/hackathons/${HACKATHON}/board`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
  if (THINK_MS > 0) sleep((THINK_MS * (0.5 + Math.random())) / 1000);
}

const fmt = (n) => (typeof n === 'number' ? n.toFixed(1) : String(n));
const vals = (m) => (m && (m.values ?? m)) || {};

export function handleSummary(data) {
  const label = __ENV.LABEL || 'run';
  const d = vals(data.metrics.http_req_duration);
  const r = vals(data.metrics.http_reqs);
  const f = vals(data.metrics.http_req_failed);
  const text =
    [
      `label:        ${label}`,
      `requests:     ${r.count}  (${fmt(r.rate)} req/s)`,
      `failed rate:  ${f.rate ?? f.value}`,
      `latency (ms): avg=${fmt(d.avg)} med=${fmt(d.med)} p90=${fmt(d['p(90)'])} ` +
        `p95=${fmt(d['p(95)'])} p99=${fmt(d['p(99)'])} max=${fmt(d.max)}`,
    ].join('\n') + '\n';
  return {
    stdout: text,
    [`reports/${label}.json`]: JSON.stringify(data, null, 2),
  };
}
