import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import { mintJobToken, revokeJobToken } from "./auth";
import { env } from "./lib/env";
import { routeFor, type Route } from "./lib/providers";
import { streamMacClaude } from "./lib/mac-claude";
import { myKeys } from "./my-keys";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { TOOL_NAMES } from "../contracts/tools";
import type { AssistantMessage, AssistantProvider, AssistantView } from "../contracts/assistant";

/**
 * The in-app assistant (the dock, src/components/assistant): one conversation per account in
 * $DATA_DIR/assistant/<user>.json (0600). A turn runs on the account's own Claude Code on a paired Mac, never on an
 * API key, and only once an AI is connected (no model call before that, nor any paid call). The Mac runs it with
 * this server's MCP tools (mcp.ts) under a job token that lives in memory for that turn (auth.ts). Nothing here
 * stores or forwards a token, and no key value the user types ever passes through this file (saved in the dock
 * straight to /api/my-keys/:env; /saved only records the last four digits).
 */

export const assistantApp = new Hono<{ Variables: AuthVars }>();

/** The job whose provider answers the dock: its own pick, else the default (contracts/providers.ts). */
const JOB = "notes";
const MAX_TEXT = 4000;
/** Each turn's prompt carries this many recent messages. */
const HISTORY = 20;

/** What the app is and what its tools do: no writing or style rules, only the facts the assistant needs. */
export const SYSTEM = `You are the assistant built into Creator Toolset, a web app for content creators. Its tools: ${Object.values(TOOL_NAMES).join(", ")}. Each has its own page in the app.

Your reply is shown in a small chat dock. You act in the app only through its tools (the creator-toolset MCP server):
- setup_status: what is set up (the AI, logins, which keys are saved, the project count). Call it before you walk someone through setup.
- The workshop_* tools (projects, sessions, pieces), list_reviews, get_review, resolve_comment and review_set_approval work on the user's own content.
- instagram_posts and instagram_refresh: the user's Instagram posts in the Analyzer and their numbers.
- editor_list, editor_get and editor_run: the AI Editor's edits, their drafts and jobs.
- navigate opens a page of the app for the user, given as a relative path such as /workshop.
- ask_secret asks the user for one API key. The app shows a secure box in the chat; the key goes straight to the app and never to you. Never ask the user to paste a key, token or password into the chat, and never repeat one back.

The keys the app takes, and what each one is for:
${MY_KEYS.map((k) => `- ${k.env} (${k.name}): ${k.what}`).join("\n")}`;

/* ---- the conversation, in memory and on disk ---- */

interface Conv {
  messages: AssistantMessage[];
  pending?: { env: string; why: string; at: number };
  navigate?: string;
}

const cache = new Map<string, Conv>();
const dirOf = () => path.join(env.dataDir, "assistant");
const fileOf = (username: string) => path.join(dirOf(), `${username}.json`);

function load(username: string): Conv {
  const hit = cache.get(username);
  if (hit) return hit;
  let conv: Conv = { messages: [] };
  try {
    conv = JSON.parse(readFileSync(fileOf(username), "utf-8")) as Conv;
  } catch {
    /* no conversation yet */
  }
  // a reply the server stopped in the middle of: it can't finish any more
  for (const m of conv.messages) if (m.status === "thinking") m.status = "error";
  cache.set(username, conv);
  return conv;
}

function save(username: string): void {
  const conv = cache.get(username);
  if (!conv) return;
  mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
  const file = fileOf(username);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(conv), { mode: 0o600 });
  renameSync(tmp, file);
}

/** Deltas of a reply are saved at most once a second; everything else saves at once. */
const pendingSave = new Map<string, ReturnType<typeof setTimeout>>();
function saveSoon(username: string): void {
  if (pendingSave.has(username)) return;
  pendingSave.set(username, setTimeout(() => {
    pendingSave.delete(username);
    save(username);
  }, 1000));
}

const messageOf = (username: string, id: string) => load(username).messages.find((m) => m.id === id);

/** The app's own path only: relative, inside this app, no scheme, host or whitespace. */
export function appPath(p: string): string | null {
  return /^\/(?!\/)[A-Za-z0-9/_.~%-]*(\?[A-Za-z0-9_=&.%-]*)?$/.test(p) ? p : null;
}

/** The assistant's navigate tool: records the page for the dock to open. */
export async function navigateTo(username: string, p: string): Promise<string> {
  const to = appPath(p);
  if (!to) throw new Error("navigate takes a relative path in this app, such as /workshop or /settings/connectors");
  load(username).navigate = to;
  save(username);
  return to;
}

/** The assistant's ask_secret tool: a pending request for one key, shown as a secure box. Never takes a value. */
export async function askSecret(username: string, env: MyKeyEnv, why: string): Promise<void> {
  load(username).pending = { env, why, at: Date.now() };
  save(username);
}

/* ---- the turn ---- */

const publicOrigin = (c: Context) => {
  const url = new URL(c.req.url);
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${url.host}`;
};

const providerOf = (route: Route | null): AssistantProvider => (!route ? "none" : route.instance.driver === "claude" ? "claude" : "other");

function view(username: string, admin: boolean): AssistantView {
  const conv = load(username);
  const pending = conv.pending ? MY_KEYS.find((k) => k.env === conv.pending!.env) : undefined;
  return {
    provider: providerOf(routeFor(username, admin, JOB)),
    messages: conv.messages.slice(-80),
    pending: pending && conv.pending ? { env: pending.env, name: pending.name, why: conv.pending.why } : null,
    navigate: conv.navigate ?? null,
  };
}

/** The prompt: the recent messages, then the reply it is for. */
function promptFor(messages: AssistantMessage[]): string {
  const lines = messages
    .filter((m) => m.status !== "thinking")
    .slice(-HISTORY)
    .map((m) => `${m.role === "user" ? "User" : m.role === "note" ? "Note" : "Assistant"}: ${m.text}`);
  return `${lines.join("\n\n")}\n\nAnswer the user's last message.`;
}

/**
 * One turn on the Mac. The job token is minted for this reply only, and revoked when the turn ends either way.
 * streamMacClaude queues the job synchronously, so the Mac's next poll gets it.
 */
async function runTurn(username: string, replyId: string, route: Route, url: string, prompt: string): Promise<void> {
  const token = mintJobToken(username, replyId);
  try {
    const text = await streamMacClaude(SYSTEM, prompt, undefined, (t) => {
      const m = messageOf(username, replyId);
      if (m) m.text = t;
      saveSoon(username);
    }, undefined, {
      label: "Assistant",
      provider: { instance: route.instance.id, driver: route.instance.driver, home: route.instance.home, model: route.selection.model, effort: route.selection.effort, device: route.device, scope: route.scope },
      mcp: { url, token },
    });
    Object.assign(messageOf(username, replyId) ?? {}, { status: "done", text });
  } catch (e) {
    // the token never goes into a stored reply
    const detail = (e instanceof Error ? e.message : String(e)).split(token).join("");
    Object.assign(messageOf(username, replyId) ?? {}, { status: "error", text: detail.slice(0, 300) || "The answer failed." });
  } finally {
    revokeJobToken(token);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
  }
}

assistantApp.use("*", async (c, next) => {
  const u = c.get("user");
  return u.role === "visitor" ? c.json({ error: "Sign in with an account to use the assistant" }, 403) : next();
});

assistantApp.get("/", (c) => {
  const u = c.get("user");
  return c.json(view(u.username, u.role === "admin"));
});

assistantApp.post("/turn", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { text?: unknown } | null;
  const text = typeof b?.text === "string" ? b.text.trim() : "";
  if (!text || text.length > MAX_TEXT) return c.json({ error: `Write a message (up to ${MAX_TEXT} characters)` }, 400);
  const conv = load(u.username);
  if (conv.messages.at(-1)?.status === "thinking") return c.json({ error: "Still answering the last message: wait for it" }, 409);
  // Before an AI is connected: no model call, no job, no paid call of any kind (the server's keys included).
  const route = routeFor(u.username, u.role === "admin", JOB);
  if (!route) return c.json({ error: "Connect your AI first", code: "NO_PROVIDER" }, 409);
  if (route.instance.driver !== "claude") return c.json({ error: "The assistant needs Claude Code on your Mac for now", code: "NOT_CLAUDE" }, 409);
  const now = Date.now();
  conv.messages.push({ id: randomUUID(), role: "user", text, at: now });
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, status: "thinking" };
  conv.messages.push(reply);
  save(u.username);
  void runTurn(u.username, reply.id, route, `${publicOrigin(c)}/api/mcp`, promptFor(conv.messages));
  return c.json(view(u.username, u.role === "admin"), 202);
});

/** The dock recorded a key the user saved in its secure box: a note with its last four digits, and the box closes. */
assistantApp.post("/saved", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { env?: unknown } | null;
  const conv = load(u.username);
  const spec = MY_KEYS.find((k) => k.env === b?.env);
  const key = spec ? myKeys(u.username)[spec.env] : undefined;
  if (!spec || !conv.pending || conv.pending.env !== spec.env || !key) return c.json({ error: "No saved key to record" }, 400);
  conv.pending = undefined;
  conv.messages.push({ id: randomUUID(), role: "note", text: `${spec.name} key saved (…${key.slice(-4)})`, at: Date.now() });
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** The user closed the secure box without saving. */
assistantApp.post("/cancel", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  conv.pending = undefined;
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** The dock opened the page navigate asked for. */
assistantApp.post("/navigated", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  conv.navigate = undefined;
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});
