import { randomUUID } from "node:crypto";
import { Hono, type MiddlewareHandler } from "hono";
import { streamSSE } from "hono/streaming";
import type { AuthVars } from "../auth";

/**
 * Live change notices: the app keeps a saved copy of every list it shows (src/lib/local-cache.ts) and this stream tells
 * it which ones changed, so a screen never polls and never waits. A notice carries no data, only
 * { seq, topic, origin }: `seq` counts every change since this server started, `topic` is the first part of the
 * changed address after /api ("review", "workshop", "x/<plug-in>"), `origin` is the tab that made the write (its
 * X-CT-Client header), so that tab does not refetch what it just saved. Each account hears only its own changes.
 * The browser derives the same topic from a saved list's address (topicOf, src/lib/sync.ts).
 * ponytail: per-account only. A change to a team's shared item reaches the member who made it, not the others;
 * add workspace fan-out when teams edit the same item at once.
 */

export const bootId = randomUUID();
let seq = 0;
/** account → topic → the seq of its newest change, for the hello a (re)connecting tab compares against */
const latest = new Map<string, Map<string, number>>();
type Listener = (n: { seq: number; topic: string; origin: string | null }) => void;
const listeners = new Map<string, Set<Listener>>();

/** The topic of an /api address: "/api/review/x" → "review", "/api/x/ba/editor" → "x/ba". Null outside /api. */
export function topicOf(path: string): string | null {
  const m = /^\/api\/(x\/[^/?#]+|[^/?#]+)/.exec(path);
  return m ? m[1] : null;
}

/** Tell this account's open tabs that a topic changed. For writes outside a request (a background job's save). */
export function announce(owner: string, topic: string, origin: string | null = null): void {
  const n = { seq: ++seq, topic, origin };
  let topics = latest.get(owner);
  if (!topics) latest.set(owner, (topics = new Map()));
  topics.set(topic, n.seq);
  for (const l of listeners.get(owner) ?? []) l(n);
}

export const currentSeq = () => seq;

/** How many change streams this account has open now (a window or a phone listening; it says nothing of which screen is up). */
export const streamsOpen = (owner: string): number => listeners.get(owner)?.size ?? 0;

/** Writes that change nothing anyone sees: the stream itself, sign-in, upload chunks, read marks, worker heartbeats. */
const QUIET = /^\/api\/(?:sync|auth|account|activity)(?:\/|$)|\/uploads?\/[^/]+(?:\/parts\/[^/]+)?$|\/(?:seen|heartbeat|ping|wait)$/;

/** After a successful write (not a GET, not a 204 "nothing happened"), announce its topic to the writer's account. */
export const announceWrites: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await next();
  const m = c.req.method;
  if (m === "GET" || m === "HEAD" || m === "OPTIONS") return;
  if (c.res.status < 200 || c.res.status >= 300 || c.res.status === 204) return;
  if (QUIET.test(c.req.path)) return;
  const owner = c.get("user")?.username;
  const topic = topicOf(c.req.path);
  if (owner && topic) announce(owner, topic, c.req.header("x-ct-client") ?? null);
};

/** GET /api/sync/events: a hello (boot id, seq, each topic's newest seq), then one "change" per change, a ping every 15 s. */
export const syncApp = new Hono<{ Variables: AuthVars }>();
syncApp.get("/events", (c) => {
  const owner = c.get("user")?.username;
  if (!owner) return c.json({ error: "Unauthorized" }, 401);
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no"); // nginx passes each event on at once
  return streamSSE(c, async (stream) => {
    const topics = Object.fromEntries(latest.get(owner) ?? []);
    await stream.writeSSE({ event: "hello", data: JSON.stringify({ boot: bootId, seq, topics }) });
    await new Promise<void>((done) => {
      const send: Listener = (n) => void stream.writeSSE({ event: "change", data: JSON.stringify(n) });
      let set = listeners.get(owner);
      if (!set) listeners.set(owner, (set = new Set()));
      set.add(send);
      const ping = setInterval(() => void stream.writeSSE({ event: "ping", data: "" }), 15_000);
      stream.onAbort(() => {
        clearInterval(ping);
        set.delete(send);
        done();
      });
    });
  });
});
