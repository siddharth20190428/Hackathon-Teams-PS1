export const httpError = (status, code, details) =>
  Object.assign(new Error(code), { status, code, ...(details ? { details } : {}) });
