import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context (request id and the acting user). It lets the audit log record
// who did what without threading extra arguments through every function.
export const requestContext = new AsyncLocalStorage();
export const getContext = () => requestContext.getStore();
export const currentContext = getContext;
