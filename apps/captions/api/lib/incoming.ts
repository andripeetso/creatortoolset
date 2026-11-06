import { AsyncLocalStorage } from "node:async_hooks";
import type { IncomingMessage, Server } from "node:http";
import { Readable } from "node:stream";
import type { Context } from "hono";

/** Vite's Hono adapter drops `c.env.incoming`; this recovers the Node request. */
export const incomingAls = new AsyncLocalStorage<IncomingMessage>();

/**
 * Node 18+ defaults requestTimeout to 5 minutes and answers 408. A large
 * video upload is one request that must be allowed to run longer than that.
 */
export function disableRequestTimeouts(
  server: Pick<Server, "requestTimeout" | "headersTimeout" | "timeout">,
): void {
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.timeout = 0;
}

export function requestBodyStream(c: Context): Readable {
  const fromEnv = (c.env as { incoming?: IncomingMessage } | undefined)
    ?.incoming;
  if (fromEnv && !fromEnv.readableEnded) return fromEnv;
  const fromAls = incomingAls.getStore();
  if (fromAls && !fromAls.readableEnded) return fromAls;
  const body = c.req.raw.body;
  if (!body) throw new Error("No body");
  return Readable.fromWeb(body as never);
}
