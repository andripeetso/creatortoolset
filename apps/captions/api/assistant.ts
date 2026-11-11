import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import { mintJobToken, revokeJobToken, touchJobToken } from "./auth";
import { announceSoon } from "./lib/announce-soon";
import { env } from "./lib/env";
import { routeFor, routeForInstance, runFields, type Route } from "./lib/providers";
import type { Selection } from "../contracts/providers";
import { validTimezone } from "../contracts/automations";
import { streamMacClaude, type MacAsk, type MacAskStatus } from "./lib/mac-claude";
import { announce } from "./lib/sync";
import { slug } from "./lib/workshop/folder";
import { myKeys } from "./my-keys";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { TOOL_NAMES } from "../contracts/tools";
import { assistantFilesApp, readFileMeta } from "./assistant-files";
import type { AssistantApproval, AssistantContext, AssistantFile, AssistantImage, AssistantMedia, AssistantMessage, AssistantPaste, AssistantProvider, AssistantView } from "../contracts/assistant";

/**
 * The in-app assistant (the dock, src/components/assistant): one conversation per account in
 * $DATA_DIR/assistant/<user>.json (0600). A turn runs on the account's own Claude Code on a paired Mac, never on an
 * API key, and only once an AI is connected (no model call before that, nor any paid call). The Mac runs it with
 * this server's MCP tools (mcp.ts) under a job token that lives in memory for that turn (auth.ts). Nothing here
 * stores or forwards a token, and no key value the user types ever passes through this file (saved in the dock
 * straight to /api/my-keys/:env; /saved only records the last four digits).
 */

export const assistantApp = new Hono<{ Variables: AuthVars }>();
assistantApp.route("/files", assistantFilesApp);

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
- instagram_posts and instagram_refresh: the user's Instagram posts in the Analyzer and their numbers. instagram_comments reads the comments under an account's posts (what people ask most); instagram_add_account adds the user's own account or another creator's.
- media_import_folder brings a folder on this computer into the Media Library (only files changed since a time, like today) and returns the script files' text there; media_search and media_folders find footage and folders (B-roll).
- editor_list, editor_get and editor_run: the AI Editor's edits, their drafts and jobs. editor_create makes a new edit from the takes' version ids (with the script and a B-roll folder) and starts it.
- schedule_task, list_scheduled_tasks, run_scheduled_task_now and delete_scheduled_task: scheduled tasks. A task is a prompt the user's AI runs on its own on a schedule (at a time on chosen weekdays, once at a date and time, or every few minutes or hours), and each run posts the prompt and its answer in an assistant chat: by default this chat. When the user asks for something to happen regularly or later, make one; say the next run, and that they can change it in Settings, Scheduled tasks.
- navigate opens a page of the app for the user, given as a relative path such as /workshop.
- show_video plays a Review video (or an AI Editor draft's preview) inside the chat, with a link to its page.
- use_file sends a video or recording (dropped in the chat, or by its path on this computer when the server runs here) to Video Notes (transcript, summary, takeaways, action items, chapters), Review (a video page with comments and a share link) or Caption Studio (captions on the video). notes_get follows a Video Note until it's ready and reads what it found.
- offer_choices puts 2 to 4 short answers under your reply as buttons; a press sends that answer as the user's next message.
- ask_secret asks the user for one API key. The app shows a secure box in the chat; the key goes straight to the app and never to you. Never ask the user to paste a key, token or password into the chat, and never repeat one back.

A folder the user dropped comes as its path on their computer. Asked to edit it, keep it to a tap or two:
1. Find what it is: a script file in the folder (media_import_folder returns their text), a Workshop session or piece whose title or script fits the folder's name, or an edit already made from it (editor_list). If one fits, say which in one line and offer_choices "Yes, that's it" / "No, it's a new video".
2. Then offer_choices "Start with my usual setup" / "Change the setup". The usual setup is how their newest edit was set up. Change the setup = navigate to the AI Editor's New edit with the footage chosen (/editor?new=1&folder=<Media Library folder id>&name=<name>, unless the editor tool says another link).
After the go, start the edit at once and say where to follow it.

The keys the app takes, and what each one is for:
${MY_KEYS.map((k) => `- ${k.env} (${k.name}): ${k.what}`).join("\n")}`;

/** Added for the dock's turns, where Claude also has the user's Mac (answerWithTools onAsk). */
export const MAC_NOTE = `

You also run on the user's own Mac, in a folder of your own there (the current folder), with Claude Code's tools: Bash, Read, Glob, Grep, Edit and Write. What Claude Code treats as safe runs at once; anything else (a command that changes something, a file write, a read outside your folder) is asked of the user in the chat first, and they allow or deny it. When they deny something, don't try it another way: say what you wanted to do and ask.`;

/** Added for a turn whose AI has no tools (not Claude Code or Codex, which get Creator Toolset's; the Mac's are Claude Code's only). */
export const NO_TOOLS_NOTE = `

In this conversation you have no Creator Toolset tools and no tools on the user's Mac. Answer from the message and what it says. When doing a thing needs a tool, say so plainly and say what the user can do instead.`;

/* ---- the conversation, in memory and on disk ---- */

/** A chat: `title` and `task` are set for one a scheduled task made (its name, its id). */
interface Chat {
  id: string;
  messages: AssistantMessage[];
  title?: string;
  task?: string;
}

interface Conv {
  /** The open chat's id, title and task (it keeps them going into `past` and coming back). */
  id?: string;
  title?: string;
  task?: string;
  messages: AssistantMessage[];
  pending?: { env: string; why: string; at: number };
  navigate?: string;
  /** Earlier conversations, newest first (New chat keeps the one it replaces here). */
  past?: Chat[];
}

/** How many earlier conversations an account keeps; the oldest goes past this. */
export const PAST_KEPT = 100;

const titleOf = (messages: AssistantMessage[]) => {
  const first = (messages.find((m) => m.role === "user")?.text || "Conversation").replace(/\s+/g, " ").trim();
  return first.length > 70 ? `${first.slice(0, 69)}…` : first;
};

/** The conversation on screen goes into the history (when it has anything) and a fresh one starts; one pushed past PAST_KEPT goes with its pictures. */
function archive(username: string, conv: Conv): void {
  if (conv.messages.length) keepPast(username, conv, [{ id: conv.id ?? randomUUID(), messages: conv.messages, title: conv.title, task: conv.task }, ...(conv.past ?? [])]);
  conv.id = randomUUID();
  conv.title = conv.task = undefined;
  conv.messages = [];
  conv.navigate = undefined;
}

/** The history capped at PAST_KEPT: the oldest scheduled-task chats go first, so runs never push the person's own chats out. */
function keepPast(username: string, conv: Conv, all: Chat[]): void {
  const out: Chat[] = [];
  for (let i = all.length - 1, over = all.length - PAST_KEPT; i >= 0 && over > 0; i--) {
    if (!all[i]!.task) continue;
    out.push(all[i]!);
    over--;
  }
  const left = all.filter((c) => !out.includes(c));
  out.push(...left.slice(PAST_KEPT));
  conv.past = left.slice(0, PAST_KEPT);
  for (const p of out) dropImages(username, p.messages);
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
const MAX_FILES = 5;
const MAX_PATHS = 5;
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
  /** Dropped videos and recordings: ids from the body, resolved to this account's files by POST /turn. */
  fileIds: string[];
  files: AssistantFile[];
  /** Folders dropped in the Mac app: absolute paths, only told to the AI (its tools read them on that computer). */
  paths: string[];
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
  if (b.files !== undefined && (!Array.isArray(b.files) || b.files.length > MAX_FILES || b.files.some((x) => typeof x !== "string"))) throw new Error(`Send up to ${MAX_FILES} videos at a time.`);
  const fileIds = (b.files ?? []) as string[];
  if (b.paths !== undefined && (!Array.isArray(b.paths) || b.paths.length > MAX_PATHS || b.paths.some((x) => typeof x !== "string" || !x.startsWith("/") || x.length > 1000 || /[\n\r\0]/.test(x))))
    throw new Error(`Drop up to ${MAX_PATHS} folders at a time.`);
  const paths = (b.paths ?? []) as string[];
  if (!text && !images.length && !pasted.length && !fileIds.length && !paths.length) throw new Error("Write a message, or add a picture or pasted text.");
  const c = (b.context && typeof b.context === "object" ? b.context : null) as Record<string, unknown> | null;
  const where = c && capped(c.path, CONTEXT_CAPS.path);
  const context: AssistantContext | undefined = c && where
    ? {
        path: where.replace(/\s+/g, " "),
        title: capped(c.title, CONTEXT_CAPS.title)?.replace(/\s+/g, " ") ?? "",
        selection: capped(c.selection, CONTEXT_CAPS.selection),
        visible: capped(c.visible, CONTEXT_CAPS.visible),
        ...(typeof c.timezone === "string" && validTimezone(c.timezone) ? { timezone: c.timezone } : {}),
      }
    : undefined;
  return { text, images, pasted, fileIds, files: [], paths, context };
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
  conv.id ??= randomUUID();
  // a reply the server stopped in the middle of: it can't finish any more
  // and it can't do what it asked
  for (const m of [conv.messages, ...(conv.past ?? []).map((p) => p.messages)].flat()) if (m.status === "thinking") {
    m.status = "error";
    expireApprovals(m, 0);
  }
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

/**
 * The account's open docks read the conversation again (api/lib/sync.ts). For a change no request of the dock made:
 * a reply is written from the Mac's answer, its tools' calls and a scheduled run, so nothing else announces it.
 */
const tell = (username: string) => announce(username, "assistant");

/** Deltas of a reply are saved at most once a second; everything else saves at once. */
const pendingSave = new Map<string, ReturnType<typeof setTimeout>>();
function saveSoon(username: string): void {
  announceSoon(username, "assistant"); // told now, not when the file lands: the dock reads the conversation in memory
  if (pendingSave.has(username)) return;
  pendingSave.set(username, setTimeout(() => {
    pendingSave.delete(username);
    save(username);
  }, 1000));
}

/** A message by id, in the open chat or an earlier one (a scheduled run streams into a chat that may not be open). */
const messageOf = (username: string, id: string) => {
  const conv = load(username);
  return conv.messages.find((m) => m.id === id) ?? conv.past?.flatMap((p) => p.messages).find((m) => m.id === id);
};

/** A tool the reply is using, as a line under it (mcp.ts). */
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

/** A video the reply shows in the chat (show_video, mcp.ts): the same id replaces its card. */
export function noteMedia(username: string, turn: string, card: AssistantMedia): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  const media = (m.media ??= []);
  const at = media.findIndex((x) => x.id === card.id);
  if (at >= 0) media[at] = card;
  else if (media.length < 10) media.push(card);
  else return;
  saveSoon(username);
}

/** Answers the reply offers as buttons (offer_choices, mcp.ts): the newest offer replaces an earlier one. */
export function noteChoices(username: string, turn: string, choices: string[]): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  m.choices = choices;
  saveSoon(username);
}

/* ---- what the reply asks to do on the user's Mac (MacOpts.onAsk) ---- */

/** Unanswered this long = no. */
export const APPROVAL_MS = 10 * 60_000;
const MAX_APPROVALS = 30;

/** Waiting approvals older than maxAge become expired; true when one did. */
function expireApprovals(m: AssistantMessage, maxAge = APPROVAL_MS, now = Date.now()): boolean {
  let changed = false;
  for (const a of m.approvals ?? []) if (a.status === "waiting" && now - a.at >= maxAge) {
    a.status = "expired";
    changed = true;
  }
  return changed;
}

/** A question from Claude Code in plain words; the exact command or path goes beside it. */
export function approvalSummary(ask: Pick<MacAsk, "tool" | "description" | "reason">): string {
  const said = ask.description.replace(/\s+/g, " ").trim();
  switch (ask.tool) {
    case "Bash":
      return said ? `Run a command: ${said}` : "Run a command on your Mac";
    case "Write":
      return "Create or replace a file";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "Change a file";
    case "Read":
    case "Glob":
    case "Grep":
      return "Look at files outside its own folder";
    case "WebFetch":
    case "WebSearch":
      return "Use the web";
    default:
      return `Use ${ask.tool}`;
  }
}

/**
 * The reply's approval for one ask: recorded the first time it comes (waiting), then its answer. A reply that's no
 * longer running, or one with too many asks, gets a no.
 */
export function approvalFor(username: string, turn: string, ask: MacAsk): MacAskStatus {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return "denied";
  const list = (m.approvals ??= []);
  let a = list.find((x) => x.id === ask.id);
  if (!a) {
    if (list.length >= MAX_APPROVALS) return "denied";
    a = { id: ask.id, tool: ask.tool, summary: approvalSummary(ask), detail: ask.detail, at: Date.now(), status: "waiting" };
    list.push(a);
    save(username);
    tell(username);
  } else if (expireApprovals(m)) {
    save(username);
    tell(username);
  }
  return a.status;
}

/** The user's answer to one of their own replies' approvals; null when there is no such approval. */
export function answerApproval(username: string, id: string, allow: boolean): AssistantApproval | null {
  for (const m of load(username).messages) {
    const a = m.approvals?.find((x) => x.id === id);
    if (!a) continue;
    if (expireApprovals(m) || a.status === "waiting") {
      if (a.status === "waiting") a.status = allow ? "allowed" : "denied";
      save(username);
    }
    return a;
  }
  return null;
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
  tell(username);
  return to;
}

/** The assistant's ask_secret tool: a pending request for one key, shown as a secure box. Never takes a value. */
export async function askSecret(username: string, env: MyKeyEnv, why: string): Promise<void> {
  load(username).pending = { env, why, at: Date.now() };
  save(username);
  tell(username);
}

/* ---- the turn ---- */

const publicOrigin = (c: Context) => {
  const url = new URL(c.req.url);
  return process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${url.host}`;
};

/**
 * The account's own AI only: the workspace's providers (the owner's own logins) answer the assistant for an admin alone.
 * `ai`: one chosen AI (a scheduled task's), null when that one can't run.
 */
export const routeOf = (username: string, admin: boolean, ai?: Selection): Route | null => {
  const r = ai ? routeForInstance(username, admin, JOB, ai) : routeFor(username, admin, JOB);
  if (ai && r?.instance.id !== ai.instance) return null;
  return r && (admin || r.scope !== "workspace") ? r : null;
};

const providerOf = (route: Route | null): AssistantProvider => (!route ? "none" : route.instance.driver === "claude" ? "claude" : "other");
/** Claude Code, Codex, Gemini CLI and Grok run with this server's MCP tools (under a job token); the others answer from the message. */
const TOOL_DRIVERS: string[] = ["claude", "codex", "gemini", "grok"];
const hasTools = (route: Route | null) => !!route && TOOL_DRIVERS.includes(route.instance.driver);

function view(username: string, admin: boolean): AssistantView {
  const conv = load(username);
  const pending = conv.pending ? MY_KEYS.find((k) => k.env === conv.pending!.env) : undefined;
  const route = routeOf(username, admin);
  return {
    id: conv.id!,
    provider: providerOf(route),
    aiName: route?.instance.name ?? "",
    tools: hasTools(route),
    messages: conv.messages.slice(-80),
    past: (conv.past ?? []).map((p) => ({ id: p.id, title: p.title ?? titleOf(p.messages), at: p.messages.at(-1)?.at ?? 0, count: p.messages.length })),
    pending: pending && conv.pending ? { env: pending.env, name: pending.name, why: conv.pending.why } : null,
    navigate: conv.navigate ?? null,
  };
}

/** An earlier message's attachments, by count and name only: their files went with that turn. */
const marks = (m: AssistantMessage) =>
  [m.images?.length ? `[${m.images.length === 1 ? "1 picture" : `${m.images.length} pictures`}]` : "", ...(m.pasted ?? []).map((n) => `[pasted: ${n}]`), ...(m.files ?? []).map((f) => `[video: ${f.name}, file id ${f.id}]`), ...(m.folders ?? []).map((p) => `[folder: ${p}]`)].filter(Boolean).join(" ");

/** What came with the newest message, as facts: its files in the folder, the page it was sent from, what was highlighted. */
function newestFacts(input: TurnInput): string[] {
  const out: string[] = [];
  const n = input.images.length;
  if (n) out.push(`The user attached ${n === 1 ? "a picture" : `${n} pictures`}: ${input.images.map((im, i) => attachedName(im.name, i, IMAGE_EXT[im.type])).join(", ")} (the Read tool shows a picture).`);
  for (const f of input.files) out.push(`The user attached ${f.mime.startsWith("audio/") ? "a recording" : "a video"}: "${f.name}" (${(f.size / 1048576).toFixed(f.size < 10485760 ? 1 : 0)} MB), file id ${f.id}.`);
  for (const p of input.paths) out.push(`The user dropped a folder from their computer: ${JSON.stringify(p)} (its path there; nothing was uploaded).`);
  for (const [i, p] of input.pasted.entries()) out.push(`The user pasted "${p.name}" (${p.text.length.toLocaleString("en-US")} characters), in ${pastedName(p.name, i)}.`);
  const c = input.context;
  if (c) {
    out.push(`The user is on ${c.path}${c.title ? ` (page title: ${c.title})` : ""}.${c.visible ? ` On screen: ${c.visible}` : ""}`);
    if (c.selection) out.push(`They highlighted this on the page: «${c.selection}»`);
    if (c.timezone) {
      const now = new Intl.DateTimeFormat("en-GB", { timeZone: c.timezone, weekday: "long", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date());
      out.push(`The user's time zone is ${c.timezone}; there it is ${now}.`);
    }
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
 * One answer from the account's AI on its Mac, with this server's MCP tools (Claude Code, Codex, Gemini CLI, Grok) under a job token made for
 * this answer only (turn names it: the reply id). The token is revoked when the answer ends
 * either way, and never appears in a thrown message. Used by the dock's turns and by scheduled runs (runInChat).
 * streamMacClaude queues the job synchronously, so the Mac's next poll gets it.
 */
export async function answerWithTools(
  username: string,
  route: Route,
  url: string,
  prompt: string,
  opts: {
    label: string;
    turn: string;
    onDelta?: (text: string) => void;
    background?: boolean;
    cancel?: AbortSignal;
    files?: Record<string, string>;
    /** Someone is there to answer: Claude may use the Mac's own tools and asks (MacOpts.onAsk). Never for scheduled runs. */
    onAsk?: (ask: MacAsk) => MacAskStatus;
  },
): Promise<string> {
  // Claude Code, Codex, Gemini CLI and Grok get Creator Toolset's MCP tools (under a job token for this answer); only Claude
  // Code also gets the Mac's tools with asks. The other drivers (OpenCode…) answer with the message alone: no token, no asks.
  // ponytail: an old Codex or Gemini CLI (no per-run MCP server) answers without the tools though the prompt names them (the Mac checks).
  const claude = route.instance.driver === "claude";
  const token = hasTools(route) ? mintJobToken(username, opts.turn) : undefined;
  const system = !token ? SYSTEM + NO_TOOLS_NOTE : claude && opts.onAsk ? SYSTEM + MAC_NOTE : SYSTEM;
  try {
    return await streamMacClaude(system, prompt, opts.cancel, (t) => opts.onDelta?.(t), undefined, {
      label: opts.label,
      background: opts.background,
      web: true, // the assistant may search and read the web, as the Workshop's writer does
      provider: { instance: route.instance.id, driver: route.instance.driver, home: route.instance.home, model: route.selection.model, effort: route.selection.effort, device: route.device, scope: route.scope, ...runFields(route.instance) },
      mcp: token ? { url, token } : undefined,
      files: opts.files,
      // a turn waiting for an approval isn't counted toward its time limit (mac-claude.ts), so its token waits too
      onAsk: claude ? opts.onAsk && ((ask) => {
        const status = opts.onAsk!(ask);
        if (status === "waiting" && token) touchJobToken(token);
        return status;
      }) : undefined,
      // Claude's own reads and searches; its MCP calls are noted by mcp.ts already, and "Thinking" is the reply's own status
      onStep: (label) => {
        if (label !== "Thinking" && !label.startsWith("mcp__")) noteStep(username, opts.turn, label);
      },
    });
  } catch (e) {
    // the token never goes into a stored reply
    const text = e instanceof Error ? e.message : String(e);
    throw new Error(token ? text.split(token).join("") : text);
  } finally {
    if (token) revokeJobToken(token);
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
      onAsk: (ask) => approvalFor(username, replyId, ask),
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
    // what it asked and nobody answered can't be done any more
    const m = messageOf(username, replyId);
    if (m) expireApprovals(m, 0);
    if (running.get(username) === stop) running.delete(username);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username);
  }
}

/* ---- scheduled runs (api/automations.ts): a task's prompt and its reply, as a turn in one of the account's chats ---- */

const chatOf = (conv: Conv, id: string | undefined): Chat | null =>
  !id ? null : conv.id === id ? (conv as Chat) : (conv.past?.find((p) => p.id === id) ?? null);

/** The chat a message is in (the chat a scheduled task was made from: the reply that made it). */
export function chatOfTurn(username: string, turn: string): string | null {
  const conv = load(username);
  if (conv.messages.some((m) => m.id === turn)) return conv.id!;
  return conv.past?.find((p) => p.messages.some((m) => m.id === turn))?.id ?? null;
}

/** A reply is being written in this chat now: a run waits for it to end. */
export function chatBusy(username: string, chat: string | undefined): boolean {
  return chatOf(load(username), chat)?.messages.at(-1)?.status === "thinking";
}

/**
 * One scheduled run as a turn: the prompt goes in as the user's message (marked with its task), the reply streams in
 * under it, and the dock shows both like any other turn. `chat` is the chat to post in; gone or absent, a new chat
 * named after the task starts among the earlier chats (the open one is left alone). `fresh`: the reply sees only this
 * prompt, not the chat's earlier messages. In the open chat, the dock's Stop stops it. Resolves with the chat and the
 * answer; rejects with the reason when the run fails.
 */
export async function runInChat(
  username: string,
  o: { chat?: string; task: { id: string; name: string }; prompt: string; preface: string; fresh: boolean; route: Route; url: string },
): Promise<{ chat: string; text: string }> {
  const conv = load(username);
  let chat = chatOf(conv, o.chat);
  if (!chat) {
    chat = { id: randomUUID(), messages: [], title: o.task.name, task: o.task.id };
    keepPast(username, conv, [chat, ...(conv.past ?? [])]);
  }
  const now = Date.now();
  const asked: AssistantMessage = { id: randomUUID(), role: "user", text: o.prompt, at: now, task: o.task };
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, status: "thinking" };
  chat.messages.push(asked, reply);
  save(username);
  tell(username);
  const prompt = `${o.preface}\n\n${promptFor(o.fresh ? [asked] : chat.messages)}`;
  const stop = new AbortController();
  const open = conv.id === chat.id && !running.has(username);
  if (open) running.set(username, stop);
  try {
    const text = await answerWithTools(username, o.route, o.url, prompt, {
      label: "Scheduled task",
      turn: reply.id,
      background: true,
      cancel: stop.signal,
      onDelta: (t) => {
        const m = messageOf(username, reply.id);
        if (m) m.text = t;
        saveSoon(username);
      },
    });
    Object.assign(messageOf(username, reply.id) ?? {}, { status: "done", text });
    return { chat: chat.id, text };
  } catch (e) {
    const why = stop.signal.aborted ? "Stopped." : (e instanceof Error ? e.message : String(e)).slice(0, 300) || "The run failed.";
    Object.assign(messageOf(username, reply.id) ?? {}, { status: stop.signal.aborted ? "done" : "error", text: why });
    throw new Error(why);
  } finally {
    if (open && running.get(username) === stop) running.delete(username);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username);
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
  for (const id of input.fileIds) {
    const f = await readFileMeta(u.username, id);
    if (!f) return c.json({ error: "A video didn't finish uploading: add it again" }, 400);
    input.files.push(f);
  }
  const conv = load(u.username);
  if (conv.messages.at(-1)?.status === "thinking") return c.json({ error: "Still answering the last message: wait for it" }, 409);
  // Before an AI is connected: no model call, no job, no paid call of any kind (the server's keys included).
  const route = routeOf(u.username, u.role === "admin");
  if (!route) return c.json({ error: "Connect your AI first", code: "NO_PROVIDER" }, 409);
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
    ...(input.files.length ? { files: input.files.map((f) => ({ id: f.id, name: f.name })) } : {}),
    ...(input.paths.length ? { folders: input.paths } : {}),
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
  archive(u.username, conv);
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
  archive(u.username, conv);
  Object.assign(conv, { id: found.id, title: found.title, task: found.task, messages: found.messages });
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

/** Allow or deny something the reply asked to do on the Mac (only the caller's own replies; anyone else's is not found). */
assistantApp.post("/approvals/:id", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { allow?: unknown } | null;
  if (typeof b?.allow !== "boolean") return c.json({ error: "Say allow: true or false" }, 400);
  const a = answerApproval(u.username, c.req.param("id"), b.allow);
  if (!a) return c.json({ error: "Not found" }, 404);
  if (a.status !== (b.allow ? "allowed" : "denied")) return c.json({ error: a.status === "expired" ? "Too late: it waited 10 minutes and wasn't done" : "Already answered" }, 409);
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
