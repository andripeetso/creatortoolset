import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { jobTurn, type AuthVars } from "../auth";
import { pageOfTurn, workspaceOfTurn } from "../assistant";
import { pluginTimelinePages } from "../lib/plugin";
import { announce } from "../lib/sync";

// The chat's editor commands (mcp-tools/nle.ts) run on the page, never here: the timeline being edited is the one open in
// the window the chat's message came from, with its unsaved edits, and Save stays the person's. A tool call queues a
// request for that window (its client id, sent with the message's page context) and tells it on topic nle:<client>; the
// page takes it (GET /pending), runs it through its own history and answers (POST /reply). No answer in 5 s: the editor
// is not open there. An answer to a request that is no longer waited for is dropped.
// shortcut: the queue is this process's memory, so a request in flight when the server restarts is lost (the tool says
// the editor is not open); keep it elsewhere if the tools ever run on more than one process.

/** The app's own timeline page, /editor/:id/:draft (not a project, /editor/p/:folder). */
const CORE = /^\/editor\/(?!p\/)([^/?#]+)\/([^/?#]+)\/?(?:[?#]|$)/;

/** The edit and draft a page path shows, when it is a timeline page (a plug-in's, or else the app's own). */
export function timelineOf(path: string | undefined): { edit: string; draft: string } | null {
  if (!path) return null;
  const pages = pluginTimelinePages();
  for (const re of pages.length ? pages : [CORE]) {
    const m = re.exec(path);
    if (m?.[1] && m[2]) return { edit: decodeURIComponent(m[1]), draft: decodeURIComponent(m[2]) };
  }
  return null;
}

export const NLE_WAIT_MS = 5000;
const NOT_THERE = "Editor commands work on the timeline the user has open, and this message was not sent from one. navigate to the draft (/editor/<edit id>/<draft>) and end your reply: their next message from there has them.";
const NOT_OPEN = "The editor did not answer: the timeline is not open in the user's window any more. navigate to the draft (/editor/<edit id>/<draft>) and end your reply.";

type Ask = { id: string; edit: string; draft: string; kind: "state" | "run"; commands?: unknown[] };
/** username + client → the requests that window has not taken yet */
const queued = new Map<string, Ask[]>();
/** request id → its caller, while it waits */
const waiting = new Map<string, { username: string; done: (r: { result?: unknown; error?: string }) => void }>();

/** The turn's timeline page and window, or null. */
const pageOf = (authorization: string | undefined) => {
  const page = pageOfTurn(jobTurn(authorization));
  const t = timelineOf(page?.path);
  return t && page?.client ? { ...t, client: page.client } : null;
};

/** The editor commands are for this turn: its message came from a timeline page, in a window that can answer. */
export const nleHere = (authorization: string | undefined): boolean => !!pageOf(authorization);

export const nleBridgeApp = new Hono<{ Variables: AuthVars }>();

/** The edit and draft the chat's message was sent from, and the chat's workspace (the tool checks the edit is in it). */
nleBridgeApp.get("/page", async (c) => {
  const p = pageOf(c.req.header("authorization"));
  if (!p) return c.json({ error: NOT_THERE }, 409);
  const workspace = await workspaceOfTurn(c.get("user").username, jobTurn(c.req.header("authorization")));
  return c.json({ edit: p.edit, draft: p.draft, ...(workspace ? { workspace } : {}) });
});

/** A request for the page, answered with what it replied (or that nothing did). A POST: Read only members are refused. */
nleBridgeApp.post("/wait", async (c) => {
  const p = pageOf(c.req.header("authorization"));
  if (!p) return c.json({ error: NOT_THERE }, 409);
  const b = (await c.req.json().catch(() => ({}))) as { kind?: unknown; commands?: unknown };
  if (b.kind !== "state" && b.kind !== "run") return c.json({ error: "kind is state or run" }, 400);
  if (b.kind === "run" && (!Array.isArray(b.commands) || !b.commands.length || b.commands.length > 50)) return c.json({ error: "Give 1 to 50 commands." }, 400);
  const username = c.get("user").username;
  const ask: Ask = { id: randomUUID(), edit: p.edit, draft: p.draft, kind: b.kind, ...(b.kind === "run" ? { commands: b.commands as unknown[] } : {}) };
  const key = `${username}\0${p.client}`;
  const answer = new Promise<{ result?: unknown; error?: string } | null>((done) => {
    const timer = setTimeout(() => done(null), NLE_WAIT_MS);
    waiting.set(ask.id, { username, done: (r) => (clearTimeout(timer), done(r)) });
  });
  queued.set(key, [...(queued.get(key) ?? []), ask]);
  announce(username, `nle:${p.client}`);
  const r = await answer;
  waiting.delete(ask.id);
  const left = (queued.get(key) ?? []).filter((a) => a.id !== ask.id);
  if (left.length) queued.set(key, left);
  else queued.delete(key);
  if (!r) return c.json({ status: "not_open", note: NOT_OPEN });
  return r.error ? c.json({ error: r.error }, 400) : c.json({ status: "done", ...(r.result !== undefined ? { result: r.result } : {}) });
});

/** The requests for this window (?client=), each handed over once. */
nleBridgeApp.get("/pending", (c) => {
  const key = `${c.get("user").username}\0${c.req.query("client") ?? ""}`;
  const asks = queued.get(key) ?? [];
  queued.delete(key);
  return c.json({ requests: asks });
});

/** The page's answer to a request: { id, result } or { id, error }. One for a request no longer waited for is dropped. */
nleBridgeApp.post("/reply", async (c) => {
  const b = (await c.req.json().catch(() => ({}))) as { id?: unknown; result?: unknown; error?: unknown };
  const w = typeof b.id === "string" ? waiting.get(b.id) : undefined;
  if (w && w.username === c.get("user").username) {
    waiting.delete(b.id as string);
    w.done(typeof b.error === "string" ? { error: b.error.slice(0, 500) } : { result: b.result });
  }
  return c.body(null, 204);
});
