// All network calls go through api(). Every write carries a fresh Idempotency-Key, so a retry or
// a double click is safe, and the session cookie travels with every request.
export const HACKATHON = 'h1';

export const routes = {
  board: `/hackathons/${HACKATHON}/board`,
  people: `/hackathons/${HACKATHON}/people`,
  myTeam: `/hackathons/${HACKATHON}/my-team`,
  teams: `/hackathons/${HACKATHON}/teams`,
  joinByCode: `/hackathons/${HACKATHON}/join-by-code`,
  events: `/hackathons/${HACKATHON}/board/events`,
};

export class ApiError extends Error {
  constructor(status, code, details, retryAfter) {
    super(code);
    this.status = status; // 0 means the server could not be reached
    this.code = code;
    this.details = details;
    this.retryAfter = retryAfter;
  }
}

let onUnauthorized = () => {};
export const setUnauthorizedHandler = (fn) => {
  onUnauthorized = fn;
};

export async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();

  let res;
  try {
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized();
    throw new ApiError(res.status, data?.error ?? `HTTP_${res.status}`, data?.details, res.headers.get('retry-after'));
  }
  return data;
}
