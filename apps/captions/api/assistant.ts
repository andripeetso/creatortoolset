import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { mintJobToken, revokeJobToken, touchJobToken } from "./auth";
import { announceSoon } from "./lib/announce-soon";
import { env } from "./lib/env";
import { routeFor, routeForInstance, runFields, type Route } from "./lib/providers";
import type { Selection } from "../contracts/providers";
import { validTimezone } from "../contracts/automations";
import { streamMacClaude, type MacAsk, type MacAskStatus } from "./lib/mac-claude";
import { announce } from "./lib/sync";
import { dockSkills, skillLines } from "./lib/skills";
import { slug } from "./lib/workshop/folder";
import { myKeys } from "./my-keys";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { TOOL_NAMES } from "../contracts/tools";
import { allPartsIn, assistantFilesApp, finishUpload, uploadOf } from "./assistant-files";
import { needsAttention, type Attention } from "./lib/attention";
import { memoryBlock } from "./lib/memory";
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
// a part or a complete for a file a waiting turn needs: the turn starts once its last file is in. The last part joins the
// file here, so a phone that is locked before it can say /complete still gets its answer
assistantApp.use("/files/:id/*", async (c, next) => {
  await next();
  const user = c.get("user")?.username;
  const id = c.req.param("id");
  if (c.req.method !== "POST" || c.res.status !== 200 || !user || !Object.values(load(user).held ?? {}).some((h) => h.files.includes(id))) return;
  if (c.req.path.endsWith("/complete")) await pump(user);
  else if (await allPartsIn(user, id)) void finishUpload(user, id).then(() => pump(user));
});
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
- The workshop_* tools (projects, sessions, pieces, a session's sources, the project the app is in), list_reviews, get_review, resolve_comment, review_set_approval and review_share (a video's public share link) work on the user's own content. review_comment writes a comment or a reply on a video, review_update renames or files it, review_folders lists or makes folders, review_trash bins it.
- instagram_posts and instagram_refresh: the user's Instagram posts in the Analyzer and their numbers. instagram_comments reads the comments under an account's posts (what people ask most); instagram_add_account adds the user's own account or another creator's. instagram_search finds posts saved in the Analyzer by words, instagram_post reads one (what is said in it, the text on screen, the idea), instagram_save saves a post by its link.
- media_import_folder brings a folder on this computer into the Media Library (only files changed since a time, like today) and returns the script files' text there; media_search and media_folders find footage and folders. Each video sorts itself as A-roll (someone talks to the camera) or B-roll (the rest): media_search's roll narrows to one. After adding files, tell the user the answer's said line. media_get reads one clip in full (its description, what is said in it, its folders), media_update changes its title, tags or description, media_add_to_folder files clips in a folder, and media_share makes a share link for a clip or a folder.
- editor_list, editor_get and editor_run: the AI Editor's edits, their drafts and jobs. editor_create makes a new edit from the takes' version ids (with the script and a B-roll folder) and starts it. An edit you start runs by itself and the chat says when it ends, so say it has started and end your reply instead of waiting. When the user answers \"Show me\", play the draft with show_video (edit and draft, as editor_get lists them) or open its page. Where the install has them: editor_stop stops an edit, editor_retry runs its failed or stopped steps again, editor_update changes its name, brief, script or settings, editor_delete moves it to the trash after asking.
- schedule_task, list_scheduled_tasks, run_scheduled_task_now and delete_scheduled_task: scheduled tasks. A task is a prompt the user's AI runs on its own on a schedule (at a time on chosen weekdays, once at a date and time, or every few minutes or hours), and each run posts the prompt and its answer in an assistant chat: by default this chat. When the user asks for something to happen regularly or later, make one; say the next run, and that they can change it in Settings, Scheduled tasks.
- navigate opens a page of the app for the user, given as a relative path such as /workshop. It can put these dialogs up for them to fill in: /settings/providers?add=1 (add an AI), /settings/connectors?add=<instagram|facebook|youtube|tiktok|x> (add a social account), /settings/devices?add=1 (add a computer) or ?phone=1 (a phone), /settings/automations?add=1 (a new scheduled task), /projects?add=1 (a new project), /settings/team?add=1 (invite someone, on a team's server).
- A name in your reply opens its page when it is a markdown link to a path of this app: [its title](/review/<id>?v=<n>), [its name](/editor/<id>), [its title](/workshop/sessions/<id>). When you list reviews, edits or sessions the user can open, link each that way (a tool's link ends in that path).
- show_video plays a Review video (or an AI Editor draft's preview) inside the chat, with a link to its page.
- use_file sends a video or recording (dropped in the chat, or by its path on this computer when the server runs here) to Video Notes (transcript, summary, takeaways, an action plan, chapters), Review (a video page with comments and a share link), Caption Studio (captions on the video) or the Media Library (footage to keep, sorted into A-roll and B-roll; several dropped files in one call; a folder on this computer goes in with media_import_folder). notes_get follows a Video Note until it's ready and reads what it found. With version_of (a Review video's link) the file becomes that video's next version instead of a new video. notes_list lists the user's Video Notes; notes_get with add writes the takeaways, the action plan or the quotes a note does not have yet. After use_file to captions the captions are made in the background and the chat says when they are ready: open the project only then (/captions?project=<id>), read them with captions_get, find projects with captions_list. There is no export tool: open the project and the person presses Export.
- offer_choices puts 2 to 4 short answers under your reply as buttons; a press sends that answer as the user's next message.
- ask_folder puts a Choose a folder button under your reply when you need a folder from their computer (in the Mac app; elsewhere it tells you to ask for a drop or a typed path). The folder they choose comes with their next message.
- A tool that deletes, publishes or sends asks the user itself, with a Yes / No card under your reply. When a tool answers that it asked, say so in a few words and end your reply: it is done when they press Yes.
- ask_secret asks the user for one API key. The app shows a secure box in the chat; the key goes straight to the app and never to you. Never ask the user to paste a key, token or password into the chat, and never repeat one back.

A folder the user dropped comes as its path on their computer. Asked to edit it, keep it to a tap or two:
1. Find what it is: a script file in the folder (look in the folder yourself when you run on their computer; media_import_folder returns the script files' text where the server is on that computer, and refuses elsewhere: then go by the other clues), a Workshop session or piece whose title or script fits the folder's name, or an edit already made from it (editor_list). Nothing fits by name and the editor can sort footage first: start it sorting, say you are reading the clips, and match what is said in them (the editor tool says how). If one fits, say which in one line and offer_choices "Yes, that's it" / "No, it's a new video".
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
  /** The newest message came from the Mac app (its page context said so): its open panel can choose a folder (askFolder). */
  mac?: boolean;
  /** The tool call each waiting Yes / No card stands for (askConfirm), by the card's id. Never sent to the dock. */
  calls?: Record<string, { tool: string; args: unknown }>;
  /** Earlier conversations, newest first (New chat keeps the one it replaces here). */
  past?: Chat[];
  /** What each turn that hasn't started needs to start, by its reply's id (it survives a restart). Never sent to the dock. */
  held?: Record<string, Held>;
}

/** A turn sent before its videos were in, or while another reply was being written: started by pump(). */
interface Held {
  /** The user message it answers. */
  ask: string;
  /** Its videos' ids (api/assistant-files.ts): the turn starts once every one is in. */
  files: string[];
  pasted: AssistantPaste[];
  context?: AssistantContext;
  /** Read when the message was sent (memoryBlock, skillLines), as the turn would have read them then. */
  memory: string;
  skills: string;
  /** This server's MCP address, as the request that sent it saw it. */
  url: string;
  admin: boolean;
  at: number;
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
        ...(c.mac === true ? { mac: true } : {}),
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
  for (const m of [conv.messages, ...(conv.past ?? []).map((p) => p.messages)].flat()) if (m.status === "thinking" && !conv.held?.[m.id]) {
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
  // this reply has just read work that ended while it was being written: it says so itself, so the waiting line is dropped
  const waiting = later.get(turn)?.filter((x) => !cardOf(card.id, x.idStart));
  if (waiting && !waiting.length) later.delete(turn);
  else if (waiting) later.set(turn, waiting);
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

/**
 * The reply asks for a folder on the user's computer (ask_folder, mcp.ts): a Choose a folder button under it. Only the
 * Mac app can choose one (its own open panel hands the page the path); elsewhere the AI is told to ask for a drop or a typed path.
 */
export function askFolder(username: string, turn: string, why: string): void {
  if (!load(username).mac) throw new Error("The user is not in the Creator Toolset Mac app, so no button can choose a folder: ask them to drop the folder on the chat, or to type its path.");
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  m.folderAsk = { why: why.replace(/\s+/g, " ").trim().slice(0, 200) };
  saveSoon(username);
}

/** Answers the reply offers as buttons (offer_choices, mcp.ts): the newest offer replaces an earlier one. */
export function noteChoices(username: string, turn: string, choices: string[]): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  m.choices = choices;
  saveSoon(username);
}

/* ---- a tool asks before it deletes, publishes or sends (mcp.ts sure) ---- */

const MAX_CONFIRMS = 10;

/** Every message list of the account: the open chat's, then each earlier chat's. */
const everyChat = (conv: Conv): AssistantMessage[][] => [conv.messages, ...(conv.past ?? []).map((p) => p.messages)];

/**
 * A tool's question as a Yes / No card under the reply, with the call it stands for kept here. The same call asked
 * twice in one reply keeps its one card. false when the reply is gone or already has too many.
 */
export function askConfirm(username: string, turn: string, question: string, call: { tool: string; args: unknown }): boolean {
  const m = messageOf(username, turn);
  if (!m || m.role !== "assistant") return false;
  const conv = load(username);
  const calls = (conv.calls ??= {});
  const list = (m.confirms ??= []);
  const same = JSON.stringify(call);
  if (list.some((x) => x.status === "waiting" && JSON.stringify(calls[x.id]) === same)) return true;
  if (list.length >= MAX_CONFIRMS) return false;
  const id = randomUUID();
  list.push({ id, question: question.replace(/\s+/g, " ").trim().slice(0, 300), at: Date.now(), status: "waiting" });
  calls[id] = call;
  save(username);
  tell(username);
  attend(username, turn, "asks", question);
  return true;
}

/** Runs a confirmed call as the person who pressed Yes (mcp.ts registers it: this file can't import that one). */
type ConfirmRunner = (user: SessionUser, headers: Headers, origin: string, tool: string, args: unknown) => Promise<{ ok: boolean; text: string }>;
let confirmRunner: ConfirmRunner | undefined;
export const setConfirmRunner = (run: ConfirmRunner): void => void (confirmRunner = run);
const answering = new Set<string>();

/** What this install's plug-ins add to the assistant's guide (mcp.ts gathers it at boot). */
let installGuide = "";
export const setInstallGuide = (text: string): void => void (installGuide = text ? `\n\n${text}` : "");

/** The reply belongs to a scheduled run: nobody is at the screen (api/automations.ts posts the prompt with its task). */
export function unattended(username: string, turn: string): boolean {
  for (const list of everyChat(load(username))) {
    const i = list.findIndex((m) => m.id === turn);
    if (i >= 0) return !!list[i - 1]?.task;
  }
  return false;
}

/* ---- work the assistant started has ended: its cards finish, and the chat says so ---- */

/** Lines waiting for a reply that is still being written in their chat, by that reply's id (said when it ends). */
const later = new Map<string, Array<{ line: AssistantMessage; idStart: string }>>();
const cardOf = (id: string, idStart: string) => id === idStart || id.startsWith(`${idStart}:`);

/**
 * Work the assistant started has ended (an edit's job, a Video Note, the Workshop's writer). Its running cards, in
 * whatever chat they sit, get their end; the cards are found by the start of their id ("edit:<id>" ends
 * "edit:<id>:new" and "edit:<id>:draft"). With `say`, one line is posted in that chat as the assistant's, with
 * answer buttons under it (`choices`: a press sends that answer). Nothing is said when no card was running: work
 * started on its own page tells nobody in the chat. While a reply is being written in that chat the line waits for
 * it to end, and is dropped if that reply reads the ended work with a tool meanwhile (noteWork): it then says so in
 * its own words, once. Returns whether a card was running.
 */
export function workEnded(username: string, idStart: string, end: { status: "done" | "failed"; detail?: string; say?: string; choices?: string[]; href?: string }): boolean {
  const conv = load(username);
  let hit = false;
  let said = false;
  for (const list of everyChat(conv)) {
    const mine = (w: NonNullable<AssistantMessage["work"]>[number]) => w.status === "running" && cardOf(w.id, idStart);
    const holders = list.filter((m) => m.work?.some(mine));
    if (!holders.length) continue;
    hit = true;
    // href: where the card leads once the work is there (a card may lead elsewhere while it runs)
    for (const w of holders.flatMap((m) => m.work!.filter(mine))) Object.assign(w, { status: end.status, ...(end.detail ? { detail: end.detail } : {}), ...(end.href ? { href: end.href } : {}) });
    if (!end.say || said) continue;
    said = true;
    // the line carries the card it is about, so "Show me" has a page to open however far back the work was started
    const about = holders.flatMap((m) => m.work!.filter((w) => cardOf(w.id, idStart)))[0];
    const line: AssistantMessage = { id: randomUUID(), role: "assistant", text: end.say, at: Date.now(), status: "done", ...(about ? { work: [{ ...about }] } : {}), ...(end.choices?.length ? { choices: end.choices.slice(0, 4) } : {}) };
    const last = list.at(-1);
    // a reply being written there keeps the last word until it ends
    if (last?.status === "thinking") later.set(last.id, [...(later.get(last.id) ?? []), { line, idStart }]);
    else list.push(line);
  }
  if (hit) {
    save(username);
    tell(username);
  }
  return hit;
}

/** A reply ended: the lines that waited for it go under it. */
function sayLater(username: string, replyId: string): void {
  const lines = later.get(replyId);
  if (!lines) return;
  later.delete(replyId);
  const list = everyChat(load(username)).find((l) => l.some((m) => m.id === replyId));
  const now = Date.now();
  list?.push(...lines.map((l, i) => ({ ...l.line, at: now + i })));
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
    attend(username, turn, "asks", `Asks to ${a.summary.charAt(0).toLowerCase()}${a.summary.slice(1)}`);
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
export async function askSecret(username: string, env: MyKeyEnv, why: string, turn?: string): Promise<void> {
  load(username).pending = { env, why, at: Date.now() };
  save(username);
  tell(username);
  if (turn) attend(username, turn, "asks", `Asks for your ${MY_KEYS.find((k) => k.env === env)?.name ?? env} key`);
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
    sendNow: true,
  };
}

/** What a reply asked before a tool deleted or sent something, and how it was answered. */
const asked = (m: AssistantMessage) =>
  (m.confirms ?? []).map((q) => `[asked: "${q.question}" → ${q.status === "waiting" ? "not answered yet" : q.status === "no" ? "the user said no" : q.status === "done" ? `yes, done${q.result ? `: ${q.result}` : ""}` : `yes, but it failed: ${q.result ?? ""}`}]`);

/** What a reply started or opened, with its page, so "show me" a few messages later has somewhere to go. */
const cards = (m: AssistantMessage) => (m.work ?? []).map((w) => `[${w.status === "running" ? "started" : w.status === "failed" ? "failed" : "made"}: ${w.title} → ${w.href}]`);

/** An earlier message's attachments, by count and name only: their files went with that turn. */
const marks = (m: AssistantMessage) =>
  [...cards(m), ...asked(m), m.images?.length ? `[${m.images.length === 1 ? "1 picture" : `${m.images.length} pictures`}]` : "", ...(m.pasted ?? []).map((n) => `[pasted: ${n}]`), ...(m.files ?? []).map((f) => `[video: ${f.name}, file id ${f.id}]`), ...(m.folders ?? []).map((p) => `[folder: ${p}]`)].filter(Boolean).join(" ");

/** What came with the newest message, as facts: its files in the folder, the page it was sent from, what was highlighted. */
function newestFacts(input: TurnInput): string[] {
  const out: string[] = [];
  const n = input.images.length;
  if (n) out.push(`The user attached ${n === 1 ? "a picture" : `${n} pictures`}: ${input.images.map((im, i) => attachedName(im.name, i, IMAGE_EXT[im.type])).join(", ")} (the Read tool shows a picture).`);
  for (const f of input.files) out.push(`The user attached ${f.mime.startsWith("audio/") ? "a recording" : "a video"}: "${f.name}" (${(f.size / 1048576).toFixed(f.size < 10485760 ? 1 : 0)} MB), file id ${f.id}.`);
  for (const p of input.paths) out.push(`The user dropped a folder from their computer: ${JSON.stringify(p)} (its path there).`);
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
    /** What the person told the assistant to keep (lib/memory.ts memoryBlock): a dock turn's alone, "" with nothing kept. */
    memory?: string;
    /** The person's own skills, a line each (lib/skills.ts skillLines): a dock turn's alone, "" with none on. */
    skills?: string;
  },
): Promise<string> {
  // Claude Code, Codex, Gemini CLI and Grok get Creator Toolset's MCP tools (under a job token for this answer); only Claude
  // Code also gets the Mac's tools with asks. The other drivers (OpenCode…) answer with the message alone: no token, no asks.
  // ponytail: an old Codex or Gemini CLI (no per-run MCP server) answers without the tools though the prompt names them (the Mac checks).
  const claude = route.instance.driver === "claude";
  const token = hasTools(route) ? mintJobToken(username, opts.turn) : undefined;
  const guide = SYSTEM + installGuide;
  let system = !token ? guide + NO_TOOLS_NOTE : claude && opts.onAsk ? guide + MAC_NOTE : guide;
  // only where the reply has the tool that opens a skill
  if (token && opts.skills) system += `\n\n${opts.skills}`;
  try {
    return await streamMacClaude(system + (opts.memory ?? ""), prompt, opts.cancel, (t) => opts.onDelta?.(t), undefined, {
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
async function runTurn(username: string, replyId: string, route: Route, url: string, prompt: string, files?: Record<string, string>, memory?: string, skills?: string): Promise<void> {
  const stop = new AbortController();
  running.set(username, stop);
  try {
    const text = await answerWithTools(username, route, url, prompt, {
      label: "Assistant",
      turn: replyId,
      cancel: stop.signal,
      files,
      memory,
      skills,
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
    sayLater(username, replyId);
    if (running.get(username) === stop) running.delete(username);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username);
    // the person hears it ended (a Stop is their own doing), and the next message's turn starts
    if (m && !stop.signal.aborted) attend(username, replyId, m.status === "error" ? "failed" : "done", m.text);
    void pump(username);
  }
}

/* ---- turns that wait: for their message's videos, or for the reply before them ---- */

/** A video that stops arriving: this long after its last part (or the message), the reply says it didn't arrive. */
export const WAIT_MS = 12 * 3600_000;
/** Replies that may wait behind the one being written; one more is refused. */
const MAX_WAITING = 10;

/** One line about a reply for whatever listens (lib/attention.ts): not for a scheduled run, nobody sent it. */
function attend(username: string, reply: string, kind: Attention["kind"], body: string): void {
  if (unattended(username, reply)) return;
  const conv = load(username);
  const chat = [{ id: conv.id!, title: conv.title, messages: conv.messages }, ...(conv.past ?? [])].find((c) => c.messages.some((m) => m.id === reply));
  if (!chat) return;
  const i = chat.messages.findIndex((m) => m.id === reply);
  const line = body.replace(/\s+/g, " ").trim();
  needsAttention({
    username,
    reply,
    kind,
    title: chat.title ?? titleOf(chat.messages),
    body: (line.length > 140 ? `${line.slice(0, 139)}…` : line) || (kind === "failed" ? "The answer failed." : "Answered."),
    path: `/?chat=${chat.id}`,
    sentAt: chat.messages.slice(0, i).reverse().find((m) => m.role === "user")?.at ?? chat.messages[i]!.at,
  });
}

/** A turn that never started ends: stopped by the person, or its video never arrived. The next one may start. */
function endHeld(username: string, m: AssistantMessage, how: "stopped" | "lost"): void {
  const conv = load(username);
  const asked = conv.messages.find((x) => x.id === conv.held?.[m.id]?.ask);
  if (conv.held) delete conv.held[m.id];
  const lost = (asked?.files ?? []).filter((f) => f.uploading).map((f) => `"${f.name}"`);
  const text = how === "stopped" ? "*Stopped.*" : `${lost.length > 1 ? `${lost.join(" and ")} didn't arrive` : `${lost[0] ?? "A video"} didn't arrive`}, so this message wasn't answered: add ${lost.length > 1 ? "them" : "it"} again and send the message again.`;
  Object.assign(m, { status: how === "stopped" ? "done" : "error", text, wait: undefined });
  sayLater(username, m.id);
  save(username);
  tell(username);
  if (how === "lost") attend(username, m.id, "failed", text);
}

const pumping = new Map<string, { again: boolean; done?: Promise<void> }>();
const wakes = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The account's waiting turns, in order: each shows what it waits for, one whose video stopped arriving ends, and the
 * first whose videos are all in starts once no reply is being written. Called whenever that may have changed (a turn
 * sent or ended, a file in, a Stop, the clock, a restart); a call during a run makes it run again, and resolves with it.
 */
function pump(username: string): Promise<void> {
  const on = pumping.get(username);
  if (on) {
    on.again = true;
    return on.done ?? Promise.resolve();
  }
  const state: { again: boolean; done?: Promise<void> } = { again: false };
  pumping.set(username, state);
  state.done = (async () => {
    try {
      do {
        state.again = false;
        await pumpOnce(username);
      } while (state.again);
    } finally {
      pumping.delete(username);
    }
  })();
  return state.done;
}

async function pumpOnce(username: string): Promise<void> {
  const conv = load(username);
  const ids = [...new Set(Object.values(conv.held ?? {}).flatMap((h) => h.files))];
  const files = new Map(
    await Promise.all(
      ids.map(async (id) => {
        let f = await uploadOf(username, id);
        // every part is in and nobody joined it: its last part came before the message did, or before a restart
        if (f && !("file" in f) && (await allPartsIn(username, id))) {
          const done = await finishUpload(username, id);
          if (!("error" in done)) f = { file: done };
        }
        return [id, f] as const;
      }),
    ),
  );
  // from here on nothing awaits: the conversation is read and changed in one go
  const held = conv.held ?? {};
  const t = Date.now();
  let changed = false;
  let soonest = Infinity;
  let ahead = running.has(username);
  for (const id of Object.keys(held)) if (messageOf(username, id)?.status !== "thinking") {
    delete held[id];
    changed = true;
  }
  for (const [i, m] of conv.messages.entries()) {
    if (m.status !== "thinking") continue;
    const h = held[m.id];
    if (!h) {
      ahead = true; // being written (a turn, or a scheduled run in this chat)
      continue;
    }
    const asked = conv.messages.find((x) => x.id === h.ask);
    const inNow = (id: string) => {
      const f = files.get(id);
      return f && "file" in f ? f.file : null;
    };
    for (const f of asked?.files ?? []) if (f.uploading && inNow(f.id)) {
      delete f.uploading;
      changed = true;
    }
    const missing = h.files.filter((id) => !inNow(id));
    let wait: AssistantMessage["wait"];
    if (missing.length) {
      // a file between its last part and its meta (being joined) has neither: only the clock says it is lost
      const last = Math.max(h.at, ...missing.map((id) => {
        const f = files.get(id);
        return f && "at" in f ? f.at : 0;
      }));
      if (t - last >= WAIT_MS) {
        endHeld(username, m, "lost");
        changed = true;
        continue;
      }
      soonest = Math.min(soonest, last + WAIT_MS);
      wait = { for: "videos", videos: missing.length, text: `Waiting for ${missing.length === 1 ? "a video" : `${missing.length} videos`} to upload` };
    } else if (ahead) wait = { for: "reply", text: "Waiting for the reply before it" };
    if (wait) {
      if (JSON.stringify(m.wait) !== JSON.stringify(wait)) {
        m.wait = wait;
        changed = true;
      }
      ahead = true;
      continue;
    }
    // one that can't start ends there, and the next may start in its place
    if (startHeld(username, conv, i, h, h.files.map((id) => inNow(id)!))) ahead = true;
    changed = true;
  }
  if (changed) {
    save(username);
    tell(username);
  }
  clearTimeout(wakes.get(username));
  wakes.delete(username);
  if (soonest < Infinity) wakes.set(username, setTimeout(() => void pump(username), Math.min(soonest - t + 1000, 2 ** 31 - 1)).unref());
}

/** A waiting turn starts, with what it was sent with: its prompt is the chat up to its own message. false: it ended instead. */
function startHeld(username: string, conv: Conv, i: number, h: Held, files: AssistantFile[]): boolean {
  const reply = conv.messages[i]!;
  const asked = conv.messages.find((x) => x.id === h.ask);
  delete conv.held![reply.id];
  reply.wait = undefined;
  const route = routeOf(username, h.admin);
  if (!route || !asked) {
    Object.assign(reply, { status: "error", text: route ? "The message is gone." : "Connect your AI first." });
    sayLater(username, reply.id);
    attend(username, reply.id, "failed", reply.text);
    return false;
  }
  const images = (asked.images ?? []).flatMap((im) => {
    const f = imageFile(username, im.id);
    return f ? [{ name: im.name, type: f.type, data: readFileSync(f.file).toString("base64"), bytes: Buffer.alloc(0) }] : [];
  });
  const input: TurnInput = { text: asked.text, images, pasted: h.pasted, fileIds: h.files, files, paths: asked.folders ?? [], context: h.context };
  conv.mac = h.context?.mac === true;
  void runTurn(username, reply.id, route, h.url, promptFor(conv.messages.slice(0, i + 1), input), filesFor(input), h.memory, h.skills);
  return true;
}

/** At boot: the accounts whose conversation file has turns waiting carry on (a test calls it to stand for a restart). */
export function resumeFromDisk(): void {
  let names: string[] = [];
  try {
    names = readdirSync(dirOf()).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names) {
    if (!readFileSync(path.join(dirOf(), f), "utf-8").includes('"held":{"')) continue;
    const username = f.slice(0, -5);
    cache.delete(username);
    void pump(username);
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

/**
 * What the person typed themselves in the chat a reply is being written in, newest first, among the messages its
 * prompt carries. A quote to remember is checked against these alone (api/memory.ts): never a reply, a note, a
 * paste or a highlight, never a scheduled task's prompt (an AI may have written it), and never an answer button
 * they pressed (offer_choices: the AI wrote those words). null for a reply that is not being written, or one of a
 * scheduled run.
 */
export function saidInChat(username: string, turn: string): Array<{ id: string; text: string; at: number }> | null {
  const list = everyChat(load(username)).find((l) => l.some((m) => m.id === turn && m.status === "thinking"));
  if (!list || unattended(username, turn)) return null;
  const sent = list.filter((m) => m.status !== "thinking");
  const typed = (m: AssistantMessage, i: number) => m.role === "user" && !m.task && !sent[i - 1]?.choices?.includes(m.text);
  return sent.map((m, i) => (typed(m, i) ? { id: m.id, text: m.text, at: m.at } : null)).slice(-HISTORY).filter((m) => !!m).reverse();
}
/** The check a quote is held to against those; an editing style's notes are held to it too (api/editor/routes.ts). */
export { foundIn } from "./lib/memory";

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
    sayLater(username, reply.id);
    if (open && running.get(username) === stop) running.delete(username);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username);
    // a message sent while it ran waited for it
    if (open) void pump(username);
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
  // a video may still be uploading (the caller's own upload): the message goes now and its turn waits for the file
  const files: NonNullable<AssistantMessage["files"]> = [];
  input.fileIds = [...new Set(input.fileIds)];
  for (const id of input.fileIds) {
    const f = await uploadOf(u.username, id);
    if (!f) return c.json({ error: "A video isn't here any more: add it again" }, 400);
    files.push("file" in f ? { id, name: f.file.name } : { id, name: f.name, uploading: true });
  }
  const memory = await memoryBlock(u);
  const skills = skillLines(await dockSkills(u.username), "tool");
  const conv = load(u.username);
  if (conv.messages.filter((m) => m.status === "thinking").length > MAX_WAITING) return c.json({ error: "Too many messages are waiting for an answer: wait for the replies" }, 409);
  // Before an AI is connected: no model call, no job, no paid call of any kind (the server's keys included).
  const route = routeOf(u.username, u.role === "admin");
  if (!route) return c.json({ error: "Connect your AI first", code: "NO_PROVIDER" }, 409);
  const now = Date.now();
  const images = input.images.map((im) => saveImage(u.username, im, im.bytes));
  const asked: AssistantMessage = {
    id: randomUUID(),
    role: "user",
    text: input.text,
    at: now,
    ...(images.length ? { images } : {}),
    ...(input.pasted.length ? { pasted: input.pasted.map((p) => p.name) } : {}),
    ...(files.length ? { files } : {}),
    ...(input.paths.length ? { folders: input.paths } : {}),
    ...(input.context?.selection ? { quote: input.context.selection } : {}),
  };
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, status: "thinking" };
  conv.messages.push(asked, reply);
  // every turn goes through the queue: one with nothing ahead and its videos in starts in this call (Stop counts on that)
  (conv.held ??= {})[reply.id] = {
    ask: asked.id,
    files: input.fileIds,
    pasted: input.pasted,
    ...(input.context ? { context: input.context } : {}),
    memory,
    skills,
    url: `${publicOrigin(c)}/api/mcp`,
    admin: u.role === "admin",
    at: now,
  };
  save(u.username);
  await pump(u.username);
  return c.json(view(u.username, u.role === "admin"), 202);
});

/**
 * Stop a reply (the dock's Stop, or Steer to send a queued message now). { reply: id } stops that one: being written,
 * or waiting (for its videos, or its turn); without it, the one being written, else the first that waits. A waiting one
 * ends at once as stopped; the next waiting message carries on.
 */
assistantApp.post("/stop", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { reply?: unknown } | null;
  const want = typeof b?.reply === "string" ? b.reply : undefined;
  const conv = load(u.username);
  const waiting = want ? (conv.held?.[want] ? want : undefined) : running.has(u.username) ? undefined : conv.messages.find((m) => m.status === "thinking" && conv.held?.[m.id])?.id;
  const m = waiting ? conv.messages.find((x) => x.id === waiting) : undefined;
  if (m) {
    endHeld(u.username, m, "stopped");
    await pump(u.username);
    return c.json(view(u.username, u.role === "admin"));
  }
  const stop = running.get(u.username);
  if (!stop || (want && messageOf(u.username, want)?.status !== "thinking")) return c.json({ error: "Nothing is running" }, 404);
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

/**
 * Yes or No to a question a tool asked before deleting, publishing or sending (only the caller's own; anyone else's
 * is not found). Yes runs the call it stands for as the caller, and the card says how it went.
 */
assistantApp.post("/confirms/:id", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { yes?: unknown } | null;
  if (typeof b?.yes !== "boolean") return c.json({ error: "Say yes: true or false" }, 400);
  const id = c.req.param("id");
  const conv = load(u.username);
  const q = everyChat(conv).flat().flatMap((m) => m.confirms ?? []).find((x) => x.id === id);
  if (!q) return c.json({ error: "Not found" }, 404);
  if (q.status !== "waiting" || answering.has(id)) return c.json({ error: "Already answered" }, 409);
  const call = conv.calls?.[id];
  if (!b.yes) q.status = "no";
  else if (!call || !confirmRunner) Object.assign(q, { status: "failed", result: "It can't be done from here any more: ask again." });
  else {
    answering.add(id);
    try {
      const r = await confirmRunner(u, c.req.raw.headers, publicOrigin(c), call.tool, call.args);
      Object.assign(q, { status: r.ok ? "done" : "failed", result: r.text.replace(/\s+/g, " ").trim().slice(0, 300) });
    } finally {
      answering.delete(id);
    }
  }
  if (conv.calls) delete conv.calls[id];
  save(u.username);
  tell(u.username);
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
