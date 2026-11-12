export const httpError = (status, code) => Object.assign(new Error(code), { status, code });
