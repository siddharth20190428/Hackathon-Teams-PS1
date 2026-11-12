import http from 'k6/http';
import { check } from 'k6';

const BASE = __ENV.BASE_URL || 'http://localhost:3000';
const HACKATHON = __ENV.HACKATHON_ID || 'h1';

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
  const res = http.get(`${BASE}/hackathons/${HACKATHON}/board`, {
    headers: { 'x-user-id': `u${__VU}` },
  });
  check(res, { 'status is 200': (r) => r.status === 200 });
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
