import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import { mintJobToken, revokeJobToken } from "./auth";
import { env } from "./lib/env";
import { routeFor, type Route } from "./lib/providers";
import { streamMacClaude } from "./lib/mac-claude";
import { slug } from "./lib/workshop/folder";
import { myKeys } from "./my-keys";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { TOOL_NAMES } from "../contracts/tools";
import type { AssistantContext, AssistantImage, AssistantMessage, AssistantPaste, AssistantProvider, AssistantView } from "../contracts/assistant";

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
const MAX_TEXT = 50_000;
/** Each turn's prompt carries this many recent messages. */
const HISTORY = 20;

/** What the app is and what its tools do: no writing or style rules, only the facts the assistant needs. */
export const SYSTEM = `You are the assistant built into Creator Toolset, a web app for content creators. Its tools: ${Object.values(TOOL_NAMES).join(", ")}. Each has its own page in the app.

Your reply is shown in a small chat dock. You act in the app only through its tools (the creator-toolset MCP server):
- setup_status: what is set up (the AI, logins, which keys are saved, the project count). Call it before you walk someone through setup.
- The workshop_* tools (projects, sessions, pieces), list_reviews, get_review, resolve_comment, review_set_approval and review_share (a video's public share link) work on the user's own content.
- instagram_posts and instagram_refresh: the user's Instagram posts in the Analyzer and their numbers.
- editor_list, editor_get and editor_run: the AI Editor's edits, their drafts and jobs.
- automations_list, automations_create, automations_update, automations_delete and automations_run: scheduled prompts. Each runs on the user's AI at a set time (daily or weekly at HH:MM in a timezone, or every N hours) and reports to the inbox and its last result.
- navigate opens a page of the app for the user, given as a relative path such as /workshop.
- ask_secret asks the user for one API key. The app shows a secure box in the chat; the key goes straight to the app and never to you. Never ask the user to paste a key, token or password into the chat, and never repeat one back.

The keys the app takes, and what each one is for:
${MY_KEYS.map((k) => `- ${k.env} (${k.name}): ${k.what}`).join("\n")}`;

/* ---- the conversation, in memory and on disk ---- */

interface Conv {
  messages: AssistantMessage[];
  pending?: { env: string; why: string; at: number };
  navigate?: string;
  /** Earlier conversations, newest first (New chat keeps the one it replaces here). */
  past?: Array<{ id: string; messages: AssistantMessage[] }>;
}

/** How many earlier conversations an account keeps; the oldest goes past this. */
const PAST_KEPT = 100;

const titleOf = (messages: AssistantMessage[]) => {
  const first = (messages.find((m) => m.role === "user")?.text || "Conversation").replace(/\s+/g, " ").trim();
  return first.length > 70 ? `${first.slice(0, 69)}…` : first;
};

/** The conversation on screen goes into the history (when it has anything) and a fresh one starts. */
function archive(conv: Conv): void {
  if (conv.messages.length) conv.past = [{ id: randomUUID(), messages: conv.messages }, ...(conv.past ?? [])].slice(0, PAST_KEPT);
  conv.messages = [];
  conv.navigate = undefined;
}

const cache = new Map<string, Conv>();
const dirOf = () => path.join(env.dataDir, "assistant");
const fileOf = (username: string) => path.join(dirOf(), `${username}.json`);

/* ---- what a message brings along: pictures (kept on disk), pastes and the page it was sent from ---- */

const IMAGE_EXT: Record<AssistantImage["type"], string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_PASTES = 5;
const MAX_PASTED = 200_000;
const CONTEXT_CAPS = { path: 300, title: 200, selection: 4000, visible: 2000 } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const imagesDir = (username: string) => path.join(dirOf(), "images", username);
/** The stored file of one of this account's pictures, or null (a strict id only: never a path). */
function imageFile(username: string, id: string): { file: string; type: AssistantImage["type"] } | null {
  if (!UUID.test(id)) return null;
  for (const [type, ext] of Object.entries(IMAGE_EXT) as Array<[AssistantImage["type"], string]>) {
    const file = path.join(imagesDir(username), `${id}.${ext}`);
    if (existsSync(file)) return { file, type };
  }
  return null;
}

function saveImage(username: string, im: AssistantImage, bytes: Buffer): { id: string; name: string } {
  const id = randomUUID();
  mkdirSync(imagesDir(username), { recursive: true, mode: 0o700 });
  const file = path.join(imagesDir(username), `${id}.${IMAGE_EXT[im.type]}`);
  writeFileSync(`${file}.tmp`, bytes, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return { id, name: im.name };
}

/** The pictures of messages that are gone for good. */
function dropImages(username: string, messages: AssistantMessage[]): void {
  for (const m of messages) for (const im of m.images ?? []) {
    const found = imageFile(username, im.id);
    if (found) rmSync(found.file, { force: true });
  }
}

interface TurnInput {
  text: string;
  images: Array<AssistantImage & { bytes: Buffer }>;
  pasted: AssistantPaste[];
  context?: AssistantContext;
}

const nameOf = (v: unknown, fallback: string) => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ").slice(0, 80) : fallback);
const capped = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined);

/** POST /turn's body, checked: a bad picture or paste is refused (one sentence), the page's own context is cut to size. */
function parseTurn(raw: unknown): TurnInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = typeof b.text === "string" ? b.text.trim() : "";
  if (text.length > MAX_TEXT) throw new Error(`Keep the message under ${MAX_TEXT} characters.`);
  if (b.images !== undefined && !Array.isArray(b.images)) throw new Error("The pictures did not come through: send them again.");
  if (b.pasted !== undefined && !Array.isArray(b.pasted)) throw new Error("The pasted text did not come through: send it again.");
  const rawImages = (b.images ?? []) as unknown[];
  const rawPasted = (b.pasted ?? []) as unknown[];
  if (rawImages.length > MAX_IMAGES) throw new Error(`Send up to ${MAX_IMAGES} pictures at a time.`);
  if (rawPasted.length > MAX_PASTES) throw new Error(`Send up to ${MAX_PASTES} pasted texts at a time.`);
  const images = rawImages.map((x, i) => {
    const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    const name = nameOf(p.name, `Picture ${i + 1}`);
    if (typeof p.type !== "string" || !(p.type in IMAGE_EXT)) throw new Error(`${name} isn't a PNG, JPEG, WebP or GIF picture.`);
    const data = typeof p.data === "string" ? p.data : "";
    if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error(`${name} did not come through: send it again.`);
    // the length says the size before anything is decoded
    if ((data.length / 4) * 3 - (data.match(/=*$/)![0].length) > MAX_IMAGE_BYTES) throw new Error(`${name} is too big: send pictures under 8 MB.`);
    return { name, type: p.type as AssistantImage["type"], data, bytes: Buffer.from(data, "base64") };
  });
  let total = 0;
  const pasted = rawPasted.map((x, i) => {
    const p = (x && typeof x === "object" ? x : {}) as Record<string, unknown>;
    if (typeof p.text !== "string") throw new Error("The pasted text did not come through: send it again.");
    total += p.text.length;
    if (total > MAX_PASTED) throw new Error(`The pasted text is too long: up to ${MAX_PASTED.toLocaleString("en-US")} characters in all.`);
    return { name: nameOf(p.name, `Pasted text ${i + 1}`), text: p.text };
  });
  if (!text && !images.length && !pasted.length) throw new Error("Write a message, or add a picture or pasted text.");
  const c = (b.context && typeof b.context === "object" ? b.context : null) as Record<string, unknown> | null;
  const where = c && capped(c.path, CONTEXT_CAPS.path);
  const context: AssistantContext | undefined = c && where
    ? {
        path: where.replace(/\s+/g, " "),
        title: capped(c.title, CONTEXT_CAPS.title)?.replace(/\s+/g, " ") ?? "",
        selection: capped(c.selection, CONTEXT_CAPS.selection),
        visible: capped(c.visible, CONTEXT_CAPS.visible),
      }
    : undefined;
  return { text, images, pasted, context };
}

/** Where the newest message's pictures and pastes sit in the folder the Mac's Claude reads. */
const attachedName = (name: string, i: number, ext: string) => `attached/${String(i + 1).padStart(2, "0")}-${slug(name.replace(/\.[a-z0-9]+$/i, ""))}.${ext}`;
const pastedName = (name: string, i: number) => `pasted/${String(i + 1).padStart(2, "0")}-${slug(name, 40)}.txt`;

/** The newest message's files for the Mac (the relay writes "base64:" entries as bytes), or undefined with none. */
function filesFor(input: TurnInput): Record<string, string> | undefined {
  const files: Record<string, string> = {};
  input.images.forEach((im, i) => (files[attachedName(im.name, i, IMAGE_EXT[im.type])] = `base64:${im.data}`));
  input.pasted.forEach((p, i) => (files[pastedName(p.name, i)] = p.text));
  return Object.keys(files).length ? files : undefined;
}

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

/** A tool the reply is using, as a line under it (mcp.ts); an automation's turn has no message, so nothing. */
export function noteStep(username: string, turn: string, step: string): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  const steps = (m.steps ??= []);
  // waiting for the writer calls the same tool again and again: one line
  if (steps.at(-1) === step || steps.length >= 40) return;
  steps.push(step);
  saveSoon(username);
}

/**
 * Something the reply started or opened, as a card under it (mcp.ts): the same id updates its card (status and
 * detail; the title it first showed stays). onlyUpdate = change a card that's there, never add one.
 */
export function noteWork(username: string, turn: string, card: NonNullable<AssistantMessage["work"]>[number], onlyUpdate = false): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  const work = (m.work ??= []);
  const had = work.find((w) => w.id === card.id);
  if (had) Object.assign(had, { status: card.status, detail: card.detail });
  else if (!onlyUpdate && work.length < 20) work.push(card);
  else return;
  saveSoon(username);
}

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

/** The account's own AI only: the workspace's providers (the owner's own logins) answer the assistant for an admin alone. */
export const routeOf = (username: string, admin: boolean): Route | null => {
  const r = routeFor(username, admin, JOB);
  return r && (admin || r.scope !== "workspace") ? r : null;
};

const providerOf = (route: Route | null): AssistantProvider => (!route ? "none" : route.instance.driver === "claude" ? "claude" : "other");

function view(username: string, admin: boolean): AssistantView {
  const conv = load(username);
  const pending = conv.pending ? MY_KEYS.find((k) => k.env === conv.pending!.env) : undefined;
  return {
    provider: providerOf(routeOf(username, admin)),
    messages: conv.messages.slice(-80),
    past: (conv.past ?? []).map((p) => ({ id: p.id, title: titleOf(p.messages), at: p.messages.at(-1)?.at ?? 0, count: p.messages.length })),
    pending: pending && conv.pending ? { env: pending.env, name: pending.name, why: conv.pending.why } : null,
    navigate: conv.navigate ?? null,
  };
}

/** An earlier message's attachments, by count and name only: their files went with that turn. */
const marks = (m: AssistantMessage) =>
  [m.images?.length ? `[${m.images.length === 1 ? "1 picture" : `${m.images.length} pictures`}]` : "", ...(m.pasted ?? []).map((n) => `[pasted: ${n}]`)].filter(Boolean).join(" ");

/** What came with the newest message, as facts: its files in the folder, the page it was sent from, what was highlighted. */
function newestFacts(input: TurnInput): string[] {
  const out: string[] = [];
  const n = input.images.length;
  if (n) out.push(`The user attached ${n === 1 ? "a picture" : `${n} pictures`}: ${input.images.map((im, i) => attachedName(im.name, i, IMAGE_EXT[im.type])).join(", ")} (the Read tool shows a picture).`);
  for (const [i, p] of input.pasted.entries()) out.push(`The user pasted "${p.name}" (${p.text.length.toLocaleString("en-US")} characters), in ${pastedName(p.name, i)}.`);
  const c = input.context;
  if (c) {
    out.push(`The user is on ${c.path}${c.title ? ` (page title: ${c.title})` : ""}.${c.visible ? ` On screen: ${c.visible}` : ""}`);
    if (c.selection) out.push(`They highlighted this on the page: «${c.selection}»`);
  }
  return out;
}

/** The prompt: the recent messages, what came with the newest one, then the reply it is for. */
function promptFor(messages: AssistantMessage[], input?: TurnInput): string {
  const newest = input ? [...messages].reverse().find((m) => m.role === "user") : undefined;
  const lines = messages
    .filter((m) => m.status !== "thinking")
    .slice(-HISTORY)
    .map((m) => `${m.role === "user" ? "User" : m.role === "note" ? "Note" : "Assistant"}: ${[m.text, m === newest ? "" : marks(m)].filter(Boolean).join(" ")}`);
  const facts = input ? newestFacts(input) : [];
  return `${lines.join("\n\n")}${facts.length ? `\n\n${facts.join("\n")}` : ""}\n\nAnswer the user's last message.`;
}

/**
 * One answer from the account's Claude Code on its Mac, with this server's MCP tools under a job token made for
 * this answer only (turn names it: the reply id, or an automation's). The token is revoked when the answer ends
 * either way, and never appears in a thrown message. Used by the dock's turns and by automations (automations.ts).
 * streamMacClaude queues the job synchronously, so the Mac's next poll gets it.
 */
export async function answerWithTools(
  username: string,
  route: Route,
  url: string,
  prompt: string,
  opts: { label: string; turn: string; onDelta?: (text: string) => void; background?: boolean; cancel?: AbortSignal; files?: Record<string, string> },
): Promise<string> {
  const token = mintJobToken(username, opts.turn);
  try {
    return await streamMacClaude(SYSTEM, prompt, opts.cancel, (t) => opts.onDelta?.(t), undefined, {
      label: opts.label,
      background: opts.background,
      web: true, // the assistant may search and read the web, as the Workshop's writer does
      provider: { instance: route.instance.id, driver: route.instance.driver, home: route.instance.home, model: route.selection.model, effort: route.selection.effort, device: route.device, scope: route.scope },
      mcp: { url, token },
      files: opts.files,
      // Claude's own reads and searches; its MCP calls are noted by mcp.ts already, and "Thinking" is the reply's own status
      onStep: (label) => {
        if (label !== "Thinking" && !label.startsWith("mcp__")) noteStep(username, opts.turn, label);
      },
    });
  } catch (e) {
    // the token never goes into a stored reply
    throw new Error((e instanceof Error ? e.message : String(e)).split(token).join(""));
  } finally {
    revokeJobToken(token);
  }
}

/** The turn each account has running, for Stop. */
const running = new Map<string, AbortController>();

/** One turn of the dock: the reply fills in as it streams, then its status says how it ended. */
async function runTurn(username: string, replyId: string, route: Route, url: string, prompt: string, files?: Record<string, string>): Promise<void> {
  const stop = new AbortController();
  running.set(username, stop);
  try {
    const text = await answerWithTools(username, route, url, prompt, {
      label: "Assistant",
      turn: replyId,
      cancel: stop.signal,
      files,
      onDelta: (t) => {
        const m = messageOf(username, replyId);
        if (m) m.text = t;
        saveSoon(username);
      },
    });
    Object.assign(messageOf(username, replyId) ?? {}, { status: "done", text });
  } catch (e) {
    const m = messageOf(username, replyId);
    // stopped: what it had written stays, marked as stopped
    if (stop.signal.aborted) Object.assign(m ?? {}, { status: "done", text: m?.text ? `${m.text}\n\n*Stopped.*` : "*Stopped.*" });
    else Object.assign(m ?? {}, { status: "error", text: (e instanceof Error ? e.message : String(e)).slice(0, 300) || "The answer failed." });
  } finally {
    if (running.get(username) === stop) running.delete(username);
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
  let input: TurnInput;
  try {
    input = parseTurn(await c.req.json().catch(() => null));
  } catch (e) {
    return c.json({ error: (e as Error).message }, 400);
  }
  const conv = load(u.username);
  if (conv.messages.at(-1)?.status === "thinking") return c.json({ error: "Still answering the last message: wait for it" }, 409);
  // Before an AI is connected: no model call, no job, no paid call of any kind (the server's keys included).
  const route = routeOf(u.username, u.role === "admin");
  if (!route) return c.json({ error: "Connect your AI first", code: "NO_PROVIDER" }, 409);
  if (route.instance.driver !== "claude") return c.json({ error: "The assistant needs Claude Code on your Mac for now", code: "NOT_CLAUDE" }, 409);
  const now = Date.now();
  // the pictures are kept only once the turn runs
  const images = input.images.map((im) => saveImage(u.username, im, im.bytes));
  conv.messages.push({
    id: randomUUID(),
    role: "user",
    text: input.text,
    at: now,
    ...(images.length ? { images } : {}),
    ...(input.pasted.length ? { pasted: input.pasted.map((p) => p.name) } : {}),
    ...(input.context?.selection ? { quote: input.context.selection } : {}),
  });
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, status: "thinking" };
  conv.messages.push(reply);
  save(u.username);
  void runTurn(u.username, reply.id, route, `${publicOrigin(c)}/api/mcp`, promptFor(conv.messages, input), filesFor(input));
  return c.json(view(u.username, u.role === "admin"), 202);
});

/** Stop the reply that's running (the dock's Stop, or Steer to send a queued message now). */
assistantApp.post("/stop", async (c) => {
  const u = c.get("user");
  const stop = running.get(u.username);
  if (!stop) return c.json({ error: "Nothing is running" }, 404);
  stop.abort();
  // the turn ends on the next tick (the Mac call rejects): answer with the view after it
  await new Promise((r) => setTimeout(r, 0));
  return c.json(view(u.username, u.role === "admin"));
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

/** New chat: the conversation goes into the history and a fresh one starts. */
assistantApp.delete("/", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  if (conv.messages.at(-1)?.status === "thinking") return c.json({ error: "Still answering: wait for it" }, 409);
  archive(conv);
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** Back to an earlier conversation: the one on screen goes into the history, and this one carries on. */
assistantApp.post("/past/:id/open", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  if (conv.messages.at(-1)?.status === "thinking") return c.json({ error: "Still answering: wait for it" }, 409);
  const found = conv.past?.find((p) => p.id === c.req.param("id"));
  if (!found) return c.json({ error: "That conversation is gone" }, 404);
  conv.past = conv.past!.filter((p) => p !== found);
  archive(conv);
  conv.messages = found.messages;
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** Delete an earlier conversation for good. */
assistantApp.delete("/past/:id", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  const found = conv.past?.find((p) => p.id === c.req.param("id"));
  if (!found) return c.json({ error: "That conversation is gone" }, 404);
  conv.past = conv.past!.filter((p) => p !== found);
  dropImages(u.username, found.messages);
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

/** One of the caller's own pictures (a message's attachment); anyone else's, or a bad id, is not found. */
assistantApp.get("/images/:id", (c) => {
  const found = imageFile(c.get("user").username, c.req.param("id"));
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.body(readFileSync(found.file), 200, { "content-type": found.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
});
