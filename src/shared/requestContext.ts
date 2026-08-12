import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

export type RequestContext = { requestId: string };

const context = new AsyncLocalStorage<RequestContext>();
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

/** Only a deliberately enabled trusted proxy may supply a correlation ID. */
export function requestIdFromHeader(value: string | undefined, trustInboundId: boolean) {
  return trustInboundId && value && REQUEST_ID_PATTERN.test(value) ? value : randomUUID();
}

export function runWithRequestContext<T>(requestId: string, callback: () => T) {
  return context.run({ requestId }, callback);
}

export function getRequestContext() {
  return context.getStore();
}
