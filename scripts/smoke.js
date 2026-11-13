// Smoke test for a running deployment: the user journey end to end over the public URL.
// Not a load test (see load/ for that). Creates a few records named "smoke-*".
//
//   BASE_URL=https://your-app.onrender.com node scripts/smoke.js
const BASE = (process.env.BASE_URL ?? '').replace(/\/$/, '');
if (!BASE) throw new Error('set BASE_URL, e.g. BASE_URL=https://your-app.onrender.com');
const HACKATHON = process.env.HACKATHON_ID ?? 'h1';

const rand = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = false;

async function api(method, path, { cookie, body } = {}) {
  const started = performance.now();
  const res = await fetch(BASE + path, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {}),
      ...(method === 'GET' ? {} : { 'idempotency-key': `smoke-${rand()}${rand()}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  const setCookie = res.headers.getSetCookie?.()[0]?.split(';')[0];
  return { status: res.status, body: json, cookie: setCookie, ms: Math.round(performance.now() - started), headers: res.headers };
}

async function step(name, fn) {
  const started = performance.now();
  try {
    const note = await fn();
    console.log(`ok    ${name}${note ? ` (${note})` : ''}  ${Math.round(performance.now() - started)} ms`);
  } catch (err) {
    failed = true;
    console.log(`FAIL  ${name}: ${err.message}`);
  }
}
const expect = (cond, message) => {
  if (!cond) throw new Error(message);
};

// A free instance sleeps when idle and takes up to a minute to wake: give it time.
async function waitUntilAwake() {
  const end = Date.now() + 120_000;
  for (let attempt = 1; Date.now() < end; attempt++) {
    try {
      const res = await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(15_000) });
      if (res.ok) return attempt;
    } catch {
      // still waking
    }
    await sleep(3000);
  }
  throw new Error('no healthy answer from /healthz within 120 s');
}

function openStream(cookie) {
  const ac = new AbortController();
  const events = [];
  const ready = fetch(`${BASE}/hackathons/${HACKATHON}/board/events`, { headers: { cookie }, signal: ac.signal }).then(
    async (res) => {
      if (res.status !== 200) return res.status;
      (async () => {
        const decoder = new TextDecoder();
        let buffer = '';
        try {
          for await (const chunk of res.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let i;
            while ((i = buffer.indexOf('\n\n')) >= 0) {
              const name = /^event: (.+)$/m.exec(buffer.slice(0, i))?.[1];
              buffer = buffer.slice(i + 2);
              if (name) events.push(name);
            }
          }
        } catch {
          // closed by us
        }
      })();
      return 200;
    },
  );
  return { ready, events, close: () => ac.abort() };
}
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(50);
  }
  return false;
};

const password = `smoke-${rand()}-${rand()}`;
const ctx = {};

await step('service is awake', async () => `${await waitUntilAwake()} attempt(s)`);

await step('register user A', async () => {
  const r = await api('POST', '/auth/register', { body: { email: `smoke-a-${rand()}@example.test`, password, displayName: 'Smoke A' } });
  expect(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  expect(r.cookie?.startsWith('session='), 'no session cookie');
  ctx.a = { cookie: r.cookie, id: r.body.user.id };
  return `${r.ms} ms`;
});
await step('session cookie works on /me', async () => {
  const r = await api('GET', '/me', { cookie: ctx.a.cookie });
  expect(r.status === 200 && r.body.user.id === ctx.a.id, `status ${r.status}`);
});
await step('board without a session is refused', async () => {
  const r = await api('GET', `/hackathons/${HACKATHON}/board`);
  expect(r.status === 401, `status ${r.status}`);
});
await step('live stream opens and says ready', async () => {
  ctx.stream = openStream(ctx.a.cookie);
  expect((await ctx.stream.ready) === 200, 'stream did not open');
  expect(await until(() => ctx.stream.events.includes('ready'), 10_000), 'no ready event (proxy buffering?)');
});
await step('create team', async () => {
  const r = await api('POST', `/hackathons/${HACKATHON}/teams`, { cookie: ctx.a.cookie, body: { name: `smoke-team-${rand()}` } });
  expect(r.status === 201, `status ${r.status} ${JSON.stringify(r.body)}`);
  ctx.team = r.body;
  return `${r.ms} ms`;
});
await step('live stream delivers a board event after the write', async () => {
  expect(await until(() => ctx.stream.events.includes('board'), 5000), 'no board event within 5 s');
});
await step('register user B and join by invite code', async () => {
  const reg = await api('POST', '/auth/register', { body: { email: `smoke-b-${rand()}@example.test`, password, displayName: 'Smoke B' } });
  expect(reg.status === 201, `register status ${reg.status}`);
  ctx.b = { cookie: reg.cookie, id: reg.body.user.id };
  const join = await api('POST', `/hackathons/${HACKATHON}/join-by-code`, { cookie: ctx.b.cookie, body: { code: ctx.team.inviteCode } });
  expect(join.status === 201, `join status ${join.status} ${JSON.stringify(join.body)}`);
  return `${join.ms} ms`;
});
await step('a wrong invite code is refused', async () => {
  const r = await api('POST', `/hackathons/${HACKATHON}/join-by-code`, { cookie: ctx.b.cookie, body: { code: 'ZZZZZZZZZZ' } });
  expect(r.status === 404 || r.status === 409, `status ${r.status}`);
});
await step('team shows up on the board', async () => {
  const r = await api('GET', `/hackathons/${HACKATHON}/board`, { cookie: ctx.b.cookie });
  expect(r.status === 200, `status ${r.status}`);
  expect(r.body.teams.some((t) => t.name === ctx.team.name), 'new team not on the board');
  return `${r.ms} ms`;
});
await step('audit log has both actions with the right actors', async () => {
  const r = await api('GET', `/teams/${ctx.team._id}/audit`, { cookie: ctx.a.cookie });
  expect(r.status === 200, `status ${r.status}`);
  const actors = r.body.entries.map((e) => e.actorId);
  expect(actors.includes(ctx.a.id) && actors.includes(ctx.b.id), `actors ${JSON.stringify(actors)}`);
});
await step('served over https, and a bad login is refused', async () => {
  expect(BASE.startsWith('https://') || BASE.startsWith('http://localhost'), 'not served over https');
  const r = await api('POST', '/auth/login', { body: { email: 'nobody@example.test', password: 'wrong-password' } });
  expect(r.status === 401, `login status ${r.status}`);
});
ctx.stream?.close();
console.log(failed ? '\nSMOKE FAILED' : '\nSMOKE PASSED');
process.exit(failed ? 1 : 0);
