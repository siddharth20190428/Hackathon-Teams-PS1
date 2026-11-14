// The Team Finder page. Plain ES module, no build step, no framework.
//
// Rules this file keeps:
// - User-supplied text (names, team names) is only ever put into the page with textContent /
//   createTextNode (through h()), never as HTML, so it cannot inject markup.
// - Every write carries a fresh Idempotency-Key, and its button is disabled while it runs, so
//   a double click or a retry cannot run twice.
// - The board refreshes on every live event (one cached read on the server). "Your team" is
//   NOT refreshed on every event, because it is not cached: it refreshes after your own
//   actions, when the stream (re)connects, when the tab comes back, and every 15 s while you
//   are in a team.
const HACKATHON = 'h1';
const $ = (id) => document.getElementById(id);

const state = { user: null, board: [], mine: { team: null }, requested: new Set() };
let stream = null;
let streamRetry = null;
let boardTimer = null;
let lastBoardKey = '';
let lastMineKey = '';
let authMode = 'login';

// ---------- small helpers ----------

// Builds an element. Children that are strings become text nodes.
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value == null) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);
  return el;
}

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
};

function messageFor(err) {
  if (err.code === 'VALIDATION_ERROR' && err.details?.length) {
    return err.details.map((d) => `${d.path}: ${d.message}`).join('; ');
  }
  if (err.code === 'RATE_LIMITED' && err.retryAfter) return `Too many attempts. Try again in ${err.retryAfter} s.`;
  if (MESSAGES[err.code]) return MESSAGES[err.code];
  return err.status ? `Something went wrong (${err.code}).` : 'Cannot reach the server. Check your connection.';
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4500);
}

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  let res;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw Object.assign(new Error('network'), { code: 'NETWORK' });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && state.user && !path.startsWith('/auth/')) signedOut('Your session ended. Please sign in again.');
    throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), {
      status: res.status,
      code: data?.error ?? `HTTP_${res.status}`,
      details: data?.details,
      retryAfter: res.headers.get('retry-after'),
    });
  }
  return data;
}

// Runs a write for a button: disabled while it runs, errors shown as a toast.
async function act(button, fn) {
  if (button?.disabled) return;
  button?.setAttribute('disabled', '');
  try {
    await fn();
  } catch (err) {
    toast(messageFor(err));
  } finally {
    button?.removeAttribute('disabled');
  }
}

const when = (iso) =>
  new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ---------- sign in / register ----------

function setAuthMode(mode) {
  authMode = mode;
  const register = mode === 'register';
  $('tab-login').setAttribute('aria-selected', String(!register));
  $('tab-register').setAttribute('aria-selected', String(register));
  $('auth-title').textContent = register ? 'Create account' : 'Sign in';
  $('auth-submit').textContent = register ? 'Create account' : 'Sign in';
  $('name-row').hidden = !register;
  $('auth-form').elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('auth-error').textContent = '';
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const email = form.elements.email.value.trim();
  const password = form.elements.password.value;
  const body = { email, password };
  if (authMode === 'register') body.displayName = form.elements.displayName.value.trim();
  $('auth-error').textContent = '';
  await act($('auth-submit'), async () => {
    try {
      const data = await api('POST', authMode === 'register' ? '/auth/register' : '/auth/login', body);
      form.elements.password.value = '';
      state.user = data.user;
      showApp();
    } catch (err) {
      $('auth-error').textContent = messageFor(err);
    }
  });
}

async function logout() {
  await api('POST', '/auth/logout').catch(() => {});
  signedOut();
}

function signedOut(message) {
  state.user = null;
  state.mine = { team: null };
  state.board = [];
  state.requested.clear();
  lastBoardKey = lastMineKey = '';
  stopStream();
  $('app').hidden = true;
  $('top-right').hidden = true;
  $('auth').hidden = false;
  setAuthMode('login'); // not left in "Create account" for the next person
  if (message) $('auth-error').textContent = message;
}

// ---------- the live stream ----------

function setLive(kind) {
  const el = $('live');
  el.dataset.state = kind;
  el.textContent = { live: 'Live', connecting: 'Connecting…', off: 'Offline, retrying' }[kind];
}

function startStream() {
  stopStream();
  setLive('connecting');
  const es = new EventSource(`/hackathons/${HACKATHON}/board/events`);
  stream = es;
  es.addEventListener('ready', () => {
    setLive('live');
    refreshBoard().catch(() => {});
    refreshMine().catch(() => {}); // an event may have been missed while disconnected
  });
  es.addEventListener('board', scheduleBoardRefresh);
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      // The server refused the stream (for example too many open): try again later.
      setLive('off');
      streamRetry = setTimeout(startStream, 5000);
    } else {
      setLive('connecting'); // the browser reconnects by itself
    }
  };
}

function stopStream() {
  clearTimeout(streamRetry);
  clearTimeout(boardTimer);
  stream?.close();
  stream = null;
}

function scheduleBoardRefresh() {
  clearTimeout(boardTimer);
  boardTimer = setTimeout(() => refreshBoard().catch(() => {}), 150);
}

// ---------- data ----------

async function refreshBoard() {
  const data = await api('GET', `/hackathons/${HACKATHON}/board`);
  const key = JSON.stringify(data.teams);
  if (key === lastBoardKey) return;
  lastBoardKey = key;
  state.board = data.teams;
  renderBoard();
}

async function refreshMine() {
  const data = await api('GET', `/hackathons/${HACKATHON}/my-team`);
  const key = JSON.stringify(data);
  if (key === lastMineKey) return;
  lastMineKey = key;
  state.mine = data;
  renderMine();
  renderBoard(); // the buttons depend on whether you are in a team
}

const refreshAll = () => Promise.all([refreshBoard(), refreshMine()]).catch(() => {});

// ---------- rendering: the board ----------

function seatsView(team) {
  const dots = Array.from({ length: team.maxSize }, (_, i) => h('i', { class: i < team.memberCount ? 'on' : '' }));
  return h('span', { class: 'seats', role: 'img', 'aria-label': `${team.memberCount} of ${team.maxSize} seats filled` }, dots);
}

function teamCard(team) {
  const mine = state.mine.team && state.mine.team._id === team._id;
  const inTeam = Boolean(state.mine.team);
  const requested = state.requested.has(team._id);
  let action;
  if (mine) action = h('span', { class: 'badge' }, 'Your team');
  else {
    action = h(
      'button',
      {
        type: 'button',
        class: 'small',
        disabled: inTeam || requested,
        title: inTeam ? 'Leave your team first' : '',
        onclick: (e) => askToJoin(team, e.currentTarget),
      },
      requested ? 'Requested' : 'Ask to join',
    );
  }
  return h(
    'li',
    { class: 'team' },
    h('div', {}, h('h3', {}, team.name), h('p', {}, seatsView(team), `${team.openSeats} open · led by ${team.leaderName}`)),
    action,
  );
}

function renderBoard() {
  const list = $('board');
  list.replaceChildren();
  $('board-hint').textContent = state.board.length ? `Showing the ${state.board.length} newest teams with open seats.` : '';
  if (!state.board.length) list.append(h('li', { class: 'empty' }, 'No team has an open seat right now.'));
  for (const team of state.board) list.append(teamCard(team));
}

async function askToJoin(team, button) {
  await act(button, async () => {
    await api('POST', `/teams/${team._id}/join-requests`);
    state.requested.add(team._id);
    toast(`Request sent to the leader of ${team.name}.`);
    renderBoard();
  });
}

// ---------- rendering: your team ----------

function renderMine() {
  const box = $('mine');
  box.replaceChildren(state.mine.team ? teamPanel() : noTeamPanel());
}

function noTeamPanel() {
  const createForm = h(
    'form',
    { novalidate: true, onsubmit: (e) => onCreate(e) },
    h('h3', {}, 'Start a team'),
    h('div', { class: 'inline' }, h('label', {}, 'Team name', h('input', { name: 'name', maxlength: '60', required: true })), h('button', { type: 'submit', class: 'primary' }, 'Create')),
  );
  const joinForm = h(
    'form',
    { novalidate: true, onsubmit: (e) => onJoinByCode(e) },
    h('h3', {}, 'Have an invite code?'),
    h('div', { class: 'inline' }, h('label', {}, 'Invite code', h('input', { name: 'code', maxlength: '20', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', required: true })), h('button', { type: 'submit' }, 'Join')),
  );
  return h('div', { class: 'stack' }, h('p', { class: 'hint' }, 'You are not in a team yet. Ask a team to let you in, join with an invite code, or start your own.'), createForm, joinForm);
}

async function onCreate(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await act(form.querySelector('button'), async () => {
    await api('POST', `/hackathons/${HACKATHON}/teams`, { name: form.elements.name.value.trim() });
    toast('Team created.');
    await refreshAll();
  });
}

async function onJoinByCode(event) {
  event.preventDefault();
  const form = event.currentTarget;
  await act(form.querySelector('button'), async () => {
    await api('POST', `/hackathons/${HACKATHON}/join-by-code`, { code: form.elements.code.value });
    toast('You joined the team.');
    await refreshAll();
  });
}

function teamPanel() {
  const { team, role, members, requests } = state.mine;
  const leader = role === 'leader';
  const parts = [
    h('div', {}, h('h3', {}, team.name, h('span', { class: 'badge' }, leader ? 'Leader' : 'Member')), h('p', { class: 'hint' }, seatsView(team), `${team.memberCount} of ${team.maxSize} seats filled`)),
    h('div', {}, h('h3', {}, 'Members'), members.map((m) => memberRow(m, leader))),
  ];
  if (leader) parts.push(invitePanel(team), requestsPanel(requests));
  parts.push(leaveButton());
  return h('div', { class: 'stack' }, parts);
}

function memberRow(member, leader) {
  const you = member.userId === state.user.id;
  const remove =
    leader && !you
      ? h('button', { type: 'button', class: 'small danger', onclick: (e) => onRemove(member, e.currentTarget) }, 'Remove')
      : null;
  return h(
    'div',
    { class: 'row' },
    h('span', { class: 'name' }, member.displayName, you ? ' (you)' : '', member.role === 'leader' ? h('span', { class: 'badge' }, 'Leader') : null),
    remove,
  );
}

async function onRemove(member, button) {
  await act(button, async () => {
    await api('DELETE', `/teams/${state.mine.team._id}/members/${encodeURIComponent(member.userId)}`);
    toast(`${member.displayName} was removed.`);
    await refreshAll();
  });
}

function invitePanel(team) {
  return h(
    'div',
    {},
    h('h3', {}, 'Invite code'),
    h('div', { class: 'row' }, h('span', { class: 'code' }, team.inviteCode), h('span', { class: 'actions' },
      h('button', { type: 'button', class: 'small', onclick: () => copyCode(team.inviteCode) }, 'Copy'),
      h('button', { type: 'button', class: 'small', onclick: (e) => onRegenerate(e.currentTarget) }, 'New code'))),
    h('p', { class: 'hint' }, `Expires ${when(team.inviteExpiresAt)}. A new code stops the old one working.`),
  );
}

async function copyCode(code) {
  try {
    await navigator.clipboard.writeText(code);
    toast('Code copied.');
  } catch {
    toast('Could not copy. Select the code and copy it by hand.');
  }
}

async function onRegenerate(button) {
  await act(button, async () => {
    await api('POST', `/teams/${state.mine.team._id}/invite/regenerate`);
    toast('New invite code created.');
    await refreshMine();
  });
}

function requestsPanel(requests) {
  const rows = requests.length
    ? requests.map((r) =>
        h('div', { class: 'row' }, h('span', { class: 'name' }, r.displayName),
          h('span', { class: 'actions' },
            h('button', { type: 'button', class: 'small primary', onclick: (e) => onDecide(r, 'accept', e.currentTarget) }, 'Accept'),
            h('button', { type: 'button', class: 'small', onclick: (e) => onDecide(r, 'decline', e.currentTarget) }, 'Decline'))),
      )
    : [h('p', { class: 'hint' }, 'No one has asked to join yet.')];
  return h('div', {}, h('h3', {}, 'Requests to join'), rows);
}

async function onDecide(request, decision, button) {
  await act(button, async () => {
    await api('POST', `/teams/${state.mine.team._id}/join-requests/${request._id}/${decision}`);
    toast(decision === 'accept' ? `${request.displayName} joined your team.` : 'Request declined.');
    await refreshAll();
  });
}

// Leaving needs a second click within a few seconds, instead of a pop-up dialog.
function leaveButton() {
  let armed = null;
  const button = h('button', { type: 'button', class: 'danger' }, 'Leave team');
  button.addEventListener('click', async () => {
    if (!armed) {
      button.textContent = 'Click again to leave';
      armed = setTimeout(() => {
        armed = null;
        button.textContent = 'Leave team';
      }, 4000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    await act(button, async () => {
      await api('POST', `/teams/${state.mine.team._id}/leave`);
      toast('You left the team.');
      await refreshAll();
    });
    button.textContent = 'Leave team';
  });
  return button;
}

// ---------- start ----------

function showApp() {
  $('auth').hidden = true;
  $('app').hidden = false;
  $('top-right').hidden = false;
  $('who').textContent = state.user.displayName;
  lastBoardKey = lastMineKey = '';
  renderBoard();
  renderMine();
  startStream();
  refreshAll();
}

$('tab-login').addEventListener('click', () => setAuthMode('login'));
$('tab-register').addEventListener('click', () => setAuthMode('register'));
$('auth-form').addEventListener('submit', submitAuth);
$('logout').addEventListener('click', logout);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.user) refreshAll();
});
setInterval(() => {
  if (document.visibilityState === 'visible' && state.user && state.mine.team) refreshMine().catch(() => {});
}, 15_000);

try {
  const { user } = await api('GET', '/me');
  state.user = user;
  showApp();
} catch {
  setAuthMode('login');
  $('auth').hidden = false;
}
