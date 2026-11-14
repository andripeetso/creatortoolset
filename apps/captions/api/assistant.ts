import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { mintJobToken, revokeJobTokens, touchJobTokens } from "./auth";
import { announceSoon } from "./lib/announce-soon";
import { env } from "./lib/env";
import { routeFor, routeForInstance, runFields, type Route } from "./lib/providers";
import type { Selection } from "../contracts/providers";
import { validTimezone } from "../contracts/automations";
import { adoptKept, adoptMacClaude, dropUnowned, keptOpen, onAdopt, SILENT_MS, streamMacClaude, type MacAsk, type MacAskStatus } from "./lib/mac-claude";
import { announce } from "./lib/sync";
import { dockSkills, skillLines } from "./lib/skills";
import { slug } from "./lib/workshop/folder";
import { myKeys } from "./my-keys";
import { MY_KEYS, type MyKeyEnv } from "../contracts/service-keys";
import { TOOL_NAMES } from "../contracts/tools";
import { allPartsIn, assistantFilesApp, finishUpload, onFileIn, removeFile, setWaitedFor, uploadOf, USE_NAMES } from "./assistant-files";
import { needsAttention, type Attention } from "./lib/attention";
import { currentProject, memoryBlock } from "./lib/memory";
import { readWorkPrefs, writeWorkPrefs } from "./work-prefs";
import type { AssistantApproval, AssistantChat, AssistantContext, AssistantFile, AssistantFileUse, AssistantImage, AssistantMedia, AssistantMessage, AssistantPaste, AssistantProvider, AssistantView } from "../contracts/assistant";

/**
 * The in-app assistant (the dock, src/components/assistant): an account's chats (the dock's open one and the earlier
 * ones, each also by its id: /chats) in $DATA_DIR/assistant/<user>.json (0600). A turn runs on the account's own Claude Code on a paired Mac, never on an
 * API key, and only once an AI is connected (no model call before that, nor any paid call). The Mac runs it with
 * this server's MCP tools (mcp.ts) under a job token that lives for that turn (auth.ts). Nothing here
 * stores or forwards a token, and no key value the user types ever passes through this file (saved in the dock
 * straight to /api/my-keys/:env; /saved only records the last four digits).
 * A restart of this server (a deploy) doesn't end a reply the Mac is still writing: it goes on in the new process
 * (lib/mac-claude.ts keeps its request; onAdopt below takes it up when the Mac's next post arrives).
 */

export const assistantApp = new Hono<{ Variables: AuthVars }>();
// a file in: the turn waiting for it has started by the time /complete answers (the last part joins it, onFileIn below)
assistantApp.use("/files/:id/complete", async (c, next) => {
  await next();
  const user = c.get("user")?.username;
  if (c.req.method === "POST" && c.res.status === 200 && user) await pump(user);
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
- design_get, design_make and design_update: the Designer's designs, each a canvas of frames (carousel slides, covers, thumbnails) made of layers the user edits by hand. You design them yourself, and you are shown each frame as it is drawn. On /design/<id> that id is the design, and the line "Picked:" on screen names the frame and layers the user has picked, by id.
- editor_list, editor_get and editor_run: the AI Editor's edits, their drafts and jobs. editor_create makes a new edit from the takes' version ids (with the script and a B-roll folder) and starts it. An edit you start runs by itself and the chat says when it ends, so say it has started and end your reply instead of waiting. When the user answers \"Show me\", play the draft with show_video (edit and draft, as editor_get lists them) or open its page. Where the install has them: editor_stop stops an edit, editor_retry runs its failed or stopped steps again, editor_update changes its name, brief, script or settings, editor_delete moves it to the trash after asking.
- Where the install has them: finals_pieces lists the user's Finals (finished pieces, each with versions and a winner) and gives the ids finals_piece_update, finals_piece_trash and finals_link_session take.
- schedule_task, list_scheduled_tasks, run_scheduled_task_now and delete_scheduled_task: scheduled tasks. A task is a prompt the user's AI runs on its own on a schedule (at a time on chosen weekdays, once at a date and time, or every few minutes or hours), and each run posts the prompt and its answer in an assistant chat: by default this chat. When the user asks for something to happen regularly or later, make one; say the next run, and that they can change it in Settings, Scheduled tasks.
- navigate opens a page of the app for the user, given as a relative path such as /workshop. It can put these dialogs up for them to fill in: /settings/providers?add=1 (add an AI), /settings/connectors?add=<instagram|facebook|youtube|tiktok|x> (add a social account), /settings/devices?add=1 (add a computer) or ?phone=1 (a phone), /settings/automations?add=1 (a new scheduled task), /projects?add=1 (a new project), /settings/team?add=1 (invite someone, on a team's server).
- A name in your reply opens its page when it is a markdown link to a path of this app: [its title](/review/<id>?v=<n>), [its name](/editor/<id>), [its title](/workshop/sessions/<id>). When you list reviews, edits or sessions the user can open, link each that way (a tool's link ends in that path).
- show_video plays a Review video (or an AI Editor draft's preview) inside the chat, with a link to its page.
- use_file sends a video or recording (dropped in the chat, or by its path on this computer when the server runs here) to Video Notes (transcript, summary, takeaways, an action plan, chapters), Review (a video page with comments and a share link), Caption Studio (captions on the video) or the Media Library (footage to keep, sorted into A-roll and B-roll; several dropped files in one call; a folder on this computer goes in with media_import_folder). notes_get follows a Video Note until it's ready and reads what it found. With version_of (a Review video's link) the file becomes that video's next version instead of a new video. notes_list lists the user's Video Notes; notes_get with add writes the takeaways, the action plan or the quotes a note does not have yet. After use_file to captions the captions are made in the background and the chat says when they are ready; the project (/captions?project=<id>) can be opened meanwhile. Read them with captions_get, find projects with captions_list. captions_export renders the video with its captions burned in by itself, and the chat says when the file is ready.
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

/** A chat: `title` and `task` are set for one a scheduled task made (its name, its id). `made`: when POST /chats made it (empty till its first message). */
interface Chat {
  id: string;
  messages: AssistantMessage[];
  title?: string;
  task?: string;
  made?: number;
  /** Settled (done with, kept): its newest message's time then. A newer message brings it back (isSettled). */
  settled?: number;
  /** When the person last sent a message in it or looked at it (POST /chats/:id/seen): a reply that ended later is unread. */
  seen?: number;
  /** Pinned to the top of the list (POST /chats/:id/pin): when. */
  pinned?: number;
  /** Put away until a time (POST /chats/:id/snooze), `at` when that was done. It is back when the time comes, or
   *  sooner when it asks something or a reply in it fails (isSnoozed); it is kept until the person has looked. */
  snooze?: { until: number; at: number };
}

/** What a chat keeps besides its messages, on its way among the earlier chats and back to being the open one. */
const kept = (c: Omit<Chat, "id" | "messages" | "made">) => ({ title: c.title, task: c.task, settled: c.settled, seen: c.seen, pinned: c.pinned, snooze: c.snooze });

interface Conv {
  /** The open chat's id, title and task (it keeps them going into `past` and coming back). */
  id?: string;
  title?: string;
  task?: string;
  settled?: number;
  seen?: number;
  pinned?: number;
  snooze?: { until: number; at: number };
  messages: AssistantMessage[];
  /** One key asked for (ask_secret), account-wide; `turn` is the reply that asked (its chat shows the box). */
  pending?: { env: string; why: string; at: number; turn?: string };
  /** One page to open: whichever reply asked last. `navigateChat` is the chat that reply is in; the page opens while
   *  that chat is the open one (a reply in a chat nobody is looking at never moves the page under another chat). */
  navigate?: string;
  navigateChat?: string;
  /** The tool call each waiting Yes / No card stands for (askConfirm), by the card's id. Never sent to the dock. */
  calls?: Record<string, { tool: string; args: unknown }>;
  /** Earlier conversations, newest first (New chat keeps the one it replaces here). */
  past?: Chat[];
  /** What each turn that hasn't started needs to start, by its reply's id (it survives a restart). Never sent to the dock. */
  held?: Record<string, Held>;
  /** What a reply a usage limit stopped needs to carry on when the limit resets, by its id (pump: "Continue where you left
   *  off."); gone once anything else is said in its chat. Never sent to the dock. */
  resume?: Record<string, Resume>;
}

type Resume = Pick<Held, "url" | "admin" | "memory" | "skills">;

/** What a chat says by itself when a usage limit that stopped its reply has reset. */
export const CONTINUE = "Continue where you left off.";

/** A turn sent before its videos were in, while the reply before it in its chat was being written, or past MAX_RUNNING: started by pump(). */
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
  /** What the message says about the project, as it was when the message was sent: which one is open (projectLine), or
   *  with dropped footage the question whether it belongs there (fitLine, askFit). */
  fit?: string;
  /** A reply that carries on once a file on the user's computer is on this server (askSend): the tool it goes to. */
  send?: AssistantFileUse;
  /** Starts without waiting for its videos (the turn's `later`): the client keeps uploading them after it ends. */
  later?: true;
}

/** How many earlier conversations an account keeps; the oldest goes past this. */
export const PAST_KEPT = 100;

const titleOf = (messages: AssistantMessage[]) => {
  const first = (messages.find((m) => m.role === "user")?.text || "Conversation").replace(/\s+/g, " ").trim();
  return first.length > 70 ? `${first.slice(0, 69)}…` : first;
};

/** The conversation on screen goes into the history (when it has anything) and a fresh one starts; one pushed past PAST_KEPT goes with its pictures. */
function archive(username: string, conv: Conv): void {
  if (conv.messages.length) keepPast(username, conv, [{ id: conv.id ?? randomUUID(), messages: conv.messages, ...kept(conv) }, ...(conv.past ?? [])]);
  // a page this chat asked for goes with it; one another chat asked for waits for that chat
  if (!conv.navigateChat || conv.navigateChat === conv.id) conv.navigate = conv.navigateChat = undefined;
  conv.id = randomUUID();
  conv.title = conv.task = conv.settled = conv.seen = conv.pinned = conv.snooze = undefined;
  conv.messages = [];
}

/** The history capped at PAST_KEPT: the oldest scheduled-task chats go first, so runs never push the person's own chats out. */
function keepPast(username: string, conv: Conv, all: Chat[]): void {
  // never a pinned chat nor one put away till later: those were kept on purpose
  const stays = (c: Chat) => !!c.pinned || (!!c.snooze && c.snooze.until > Date.now());
  const out: Chat[] = [];
  let over = all.length - PAST_KEPT;
  for (const goes of [(c: Chat) => !!c.task && !stays(c), (c: Chat) => !stays(c)])
    for (let i = all.length - 1; i >= 0 && over > 0; i--) {
      const c = all[i]!;
      if (out.includes(c) || !goes(c)) continue;
      out.push(c);
      over--;
    }
  conv.past = all.filter((c) => !out.includes(c));
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
// a shoot's worth of clips; the AI Editor takes up to 50 chat videos in one edit
const MAX_FILES = 50;
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

/** A picture of a chat as a file of its own (a branch's): either chat can go without taking the other's. */
function copyImage(username: string, im: { id: string; name: string }): { id: string; name: string } {
  const found = imageFile(username, im.id);
  if (!found) return im;
  const id = randomUUID();
  copyFileSync(found.file, path.join(imagesDir(username), `${id}.${IMAGE_EXT[found.type]}`));
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
  /** Videos dropped in the Mac app: their paths, read where they are (nothing uploads). */
  local: string[];
  /** Where its pictures and pastes go in the Mac's assistant folder, which every reply shares: "" or "place-<n>/" (placeOf). */
  dir?: string;
  context?: AssistantContext;
  /** One more line for the AI: the fit question, or what the reply carries on with. */
  note?: string;
  /** The client keeps uploading after the reply ends: the reply starts without waiting for its videos. */
  later?: true;
  /** Its videos still on their way when the reply starts. */
  uploading?: Array<{ id: string; name: string }>;
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
  if (b.localFiles !== undefined && (!Array.isArray(b.localFiles) || b.localFiles.length > MAX_FILES || b.localFiles.some((x) => typeof x !== "string" || !x.startsWith("/") || x.length > 1000 || /[\n\r\0]/.test(x))))
    throw new Error(`Send up to ${MAX_FILES} videos at a time.`);
  const local = (b.localFiles ?? []) as string[];
  if (!text && !images.length && !pasted.length && !fileIds.length && !paths.length && !local.length) throw new Error("Write a message, or add a picture or pasted text.");
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
  return { text, images, pasted, fileIds, files: [], paths, local, context, ...(b.later === true ? { later: true as const } : {}) };
}

/** Where the newest message's pictures and pastes sit in the folder the Mac's Claude reads. */
const attachedName = (name: string, i: number, ext: string, dir = "") => `${dir}attached/${String(i + 1).padStart(2, "0")}-${slug(name.replace(/\.[a-z0-9]+$/i, ""))}.${ext}`;
const pastedName = (name: string, i: number, dir = "") => `${dir}pasted/${String(i + 1).padStart(2, "0")}-${slug(name, 40)}.txt`;

/** The newest message's files for the Mac (the relay writes "base64:" entries as bytes), or undefined with none. */
function filesFor(input: TurnInput): Record<string, string> | undefined {
  const files: Record<string, string> = {};
  input.images.forEach((im, i) => (files[attachedName(im.name, i, IMAGE_EXT[im.type], input.dir)] = `base64:${im.data}`));
  input.pasted.forEach((p, i) => (files[pastedName(p.name, i, input.dir)] = p.text));
  return Object.keys(files).length ? files : undefined;
}

/**
 * Each chat file's time as this process last read or wrote it. One that differs was written by another process of
 * this server (a deploy's reload runs the old and the new side by side for some seconds) and is read again, so
 * neither writes over what the other just saved.
 */
const stamps = new Map<string, number>();
const stampOf = (username: string): number => {
  try {
    return statSync(fileOf(username)).mtimeMs;
  } catch {
    return 0; // no conversation yet
  }
};

function load(username: string): Conv {
  const hit = cache.get(username);
  const stamp = stampOf(username); // before the read: a write that lands after it is seen at the next load
  if (hit && stamp === stamps.get(username)) return hit;
  stamps.set(username, stamp);
  let conv: Conv = { messages: [] };
  try {
    conv = JSON.parse(readFileSync(fileOf(username), "utf-8")) as Conv;
  } catch {
    /* no conversation yet */
  }
  conv.id ??= randomUUID();
  // a reply a restart of the server ended: it can't finish any more and it can't do what it asked. Said in words: the
  // dock shows a failed reply without any as "That didn't work." Not one a computer is still writing (kept: it goes on
  // when that computer's next post arrives) or one running here.
  let kept: Set<string> | undefined;
  for (const m of [conv.messages, ...(conv.past ?? []).map((p) => p.messages)].flat()) if (m.status === "thinking" && !conv.held?.[m.id] && !runsOf(username).has(m.id)) {
    if ((kept ??= keptTurns()).has(m.id)) continue;
    Object.assign(m, { status: "error", text: RESTARTED });
    expireApprovals(m, 0);
  }
  cache.set(username, conv);
  return conv;
}

/** The replies a computer was writing when the process before this one stopped, and nothing here runs yet (lib/mac-claude.ts keptOpen). */
const keptTurns = () => new Set(keptOpen().filter((o) => o.keep.kind === "assistant").map((o) => String(o.keep.turn)));

function save(username: string): void {
  const conv = cache.get(username);
  if (!conv) return;
  mkdirSync(dirOf(), { recursive: true, mode: 0o700 });
  const file = fileOf(username);
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(conv), { mode: 0o600 });
  renameSync(tmp, file);
  stamps.set(username, stampOf(username));
}

/**
 * The account's open docks read the conversation again (api/lib/sync.ts). For a change no request of the dock made:
 * a reply is written from the Mac's answer, its tools' calls and a scheduled run, so nothing else announces it.
 */
const tell = (username: string, turn?: string) => announce(username, "assistant", null, (turn && chatOfTurn(username, turn)) || undefined);

/** Deltas of a reply are saved at most once a second; everything else saves at once. */
const pendingSave = new Map<string, ReturnType<typeof setTimeout>>();
function saveSoon(username: string, turn?: string): void {
  announceSoon(username, "assistant", 1000, (turn && chatOfTurn(username, turn)) || undefined); // told now, not when the file lands: the dock reads the conversation in memory
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
  saveSoon(username, turn);
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
  saveSoon(username, turn);
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
  saveSoon(username, turn);
}

/**
 * The reply asks for a folder on the user's computer (ask_folder, mcp.ts): a Choose a folder button under it. Only the
 * Mac app can choose one (its own open panel hands the page the path); elsewhere the AI is told to ask for a drop or a typed path.
 */
export function askFolder(username: string, turn: string, why: string): void {
  if (!fromMac.has(turn)) throw new Error("The user is not in the Creator Toolset Mac app, so no button can choose a folder: ask them to drop the folder on the chat, or to type its path.");
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  m.folderAsk = { why: why.replace(/\s+/g, " ").trim().slice(0, 200) };
  saveSoon(username, turn);
}

/** Answers the reply offers as buttons (offer_choices, mcp.ts): the newest offer replaces an earlier one. */
export function noteChoices(username: string, turn: string, choices: string[]): void {
  const m = messageOf(username, turn);
  if (m?.status !== "thinking") return;
  m.choices = choices;
  saveSoon(username, turn);
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
  tell(username, turn);
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

/** The scheduled task a reply is a run of (api/automations.ts posts the prompt with its task). */
function taskOf(username: string, turn: string): AssistantMessage["task"] {
  for (const list of everyChat(load(username))) {
    const i = list.findIndex((m) => m.id === turn);
    if (i >= 0) return list[i - 1]?.task;
  }
  return undefined;
}
/** The reply belongs to a scheduled run: nobody is at the screen. */
export const unattended = (username: string, turn: string): boolean => !!taskOf(username, turn);

/* ---- work the assistant started has ended: its cards finish, and the chat says so ---- */

/**
 * Lines waiting for a reply that is still being written in their chat, by that reply's id (said when it ends).
 * ponytail: in memory, so a line waiting for a reply that goes on after a restart is never said; the work's own card still shows its end. Kept in the conversation file if that is missed.
 */
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
    tell(username, turn);
    attend(username, turn, "asks", `Asks to ${a.summary.charAt(0).toLowerCase()}${a.summary.slice(1)}`);
  } else if (expireApprovals(m)) {
    save(username);
    tell(username, turn);
  }
  return a.status;
}

/** The user's answer to one of their own replies' approvals, in whatever chat; null when there is no such approval. */
export function answerApproval(username: string, id: string, allow: boolean): AssistantApproval | null {
  const all = everyChat(load(username)).flat();
  // the Mac's ask ids are Claude's own tool-call ids: a waiting one first, should one ever repeat
  for (const m of [...all.filter((x) => x.approvals?.some((a) => a.id === id && a.status === "waiting")), ...all]) {
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

/** The assistant's navigate tool: records the page for the dock to open. `turn` is the reply that asked: the page opens in its chat. */
export async function navigateTo(username: string, p: string, turn?: string): Promise<string> {
  const to = appPath(p);
  if (!to) throw new Error("navigate takes a relative path in this app, such as /workshop or /settings/connectors");
  const conv = load(username);
  conv.navigate = to;
  conv.navigateChat = (turn && chatOfTurn(username, turn)) || undefined;
  save(username);
  tell(username);
  return to;
}

/** The assistant's ask_secret tool: a pending request for one key, shown as a secure box. Never takes a value. */
export async function askSecret(username: string, env: MyKeyEnv, why: string, turn?: string): Promise<void> {
  load(username).pending = { env, why, at: Date.now(), ...(turn ? { turn } : {}) };
  save(username);
  tell(username, turn);
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

/**
 * The open chat's view (the dock), or with `chat` that chat's (GET /chats/:id): its messages, and the key box only when
 * a reply in it asked (the open view shows the box whoever asked, as before). A chat's view lists no earlier chats: GET /chats does.
 */
function view(username: string, admin: boolean, chat?: Chat): AssistantView {
  const conv = load(username);
  const ask = conv.pending && (!chat || !conv.pending.turn || chat.messages.some((m) => m.id === conv.pending!.turn)) ? conv.pending : undefined;
  const pending = ask ? MY_KEYS.find((k) => k.env === ask.env) : undefined;
  const route = routeOf(username, admin);
  return {
    id: chat?.id ?? conv.id!,
    provider: providerOf(route),
    aiName: route?.instance.name ?? "",
    tools: hasTools(route),
    messages: (chat ?? conv).messages.slice(-80),
    // a chat made by POST /chats shows here once it has a message
    past: chat ? [] : (conv.past ?? []).filter((p) => p.messages.length).map((p) => ({ id: p.id, title: p.title ?? titleOf(p.messages), at: p.messages.at(-1)?.at ?? 0, count: p.messages.length, ...(working(p) ? { working: true as const } : {}), ...(isSettled(conv, p) ? { settled: true as const } : {}) })),
    pending: pending && ask ? { env: pending.env, name: pending.name, why: ask.why } : null,
    ...(isSnoozed(conv, chat ?? (conv as Chat)) ? { snoozed: (chat ?? conv).snooze!.until } : {}),
    navigate: (!conv.navigateChat || conv.navigateChat === (chat?.id ?? conv.id) ? conv.navigate : undefined) ?? null,
    sendNow: true,
    videosLater: true,
    chats: true,
  };
}

const working = (c: Chat) => c.messages.some((m) => m.status === "thinking");

/** A reply in the chat waits for the person: an Allow / Deny, a Yes / No card, or a key's box. */
function asking(conv: Conv, c: Chat, now = Date.now()): boolean {
  return (
    c.messages.some((m) => m.approvals?.some((a) => a.status === "waiting" && now - a.at < APPROVAL_MS) || m.confirms?.some((q) => q.status === "waiting")) ||
    (!!conv.pending?.turn && c.messages.some((m) => m.id === conv.pending!.turn))
  );
}

/** Every chat, the open one included, newest first (GET /chats). */
/** Settled and nothing new since: no newer message, no reply at work, nothing it asks. Every device folds it away. */
/** Its newest reply ended after the person last sent or looked: finished (or failed) and not seen yet. A chat from before
 *  `seen` was kept, or a scheduled task's run nobody sent, is never unread. */
function unread(c: Chat): boolean {
  if (c.seen === undefined || working(c)) return false;
  const m = [...c.messages].reverse().find((x) => x.role === "assistant");
  return !!m && m.status !== "thinking" && (m.started ?? m.at) + (m.took ?? 0) > c.seen;
}

const isSettled = (conv: Conv, c: Chat) => c.settled !== undefined && (c.messages.at(-1)?.at ?? 0) <= c.settled && !working(c) && !asking(conv, c);
/**
 * Put away and still away: its time has not come, nothing in it asks the person, and no reply in it failed since.
 * A reply that ends well does not bring it back (a scheduled task posts in its chat on every run); the person's own
 * message does (sendTurn takes the snooze away).
 */
const isSnoozed = (conv: Conv, c: Chat, now = Date.now()) =>
  !!c.snooze && c.snooze.until > now && !asking(conv, c, now) && !c.messages.some((m) => m.role === "assistant" && m.status === "error" && (m.started ?? m.at) + (m.took ?? 0) > c.snooze!.at);
/** What a chat last made or opened: its newest card. */
const onOf = (c: Chat) => {
  for (let i = c.messages.length - 1; i >= 0; i--) {
    const w = c.messages[i]!.work?.at(-1);
    if (w) return { kind: w.kind, title: w.title };
  }
  return undefined;
};

function chatList(username: string): AssistantChat[] {
  const conv = load(username);
  const all: Chat[] = [{ id: conv.id!, ...kept(conv), messages: conv.messages }, ...(conv.past ?? [])];
  return all
    .map((c) => {
      const line = ([...c.messages].reverse().find((m) => m.text.trim())?.text ?? "").replace(/\s+/g, " ").trim();
      return {
        id: c.id,
        title: c.title ?? titleOf(c.messages),
        at: c.messages.at(-1)?.at ?? c.made ?? 0,
        last: line.length > 140 ? `${line.slice(0, 139)}…` : line,
        count: c.messages.length,
        ...(c.id === conv.id ? { open: true as const } : {}),
        ...(working(c) ? { working: true as const } : {}),
        ...(asking(conv, c) ? { asks: true as const } : {}),
        ...(unread(c) ? { unread: true as const } : {}),
        ...(isSettled(conv, c) ? { settled: true as const } : {}),
        ...(c.pinned ? { pinned: c.pinned } : {}),
        ...(isSnoozed(conv, c) ? { snoozed: c.snooze!.until } : c.snooze ? { woke: true as const } : {}),
        ...(c.messages.at(-1)?.limit ? { limited: true as const } : {}),
        ...(onOf(c) ? { on: onOf(c) } : {}),
      };
    })
    .sort((a, b) => b.at - a.at);
}

/** What a reply asked before a tool deleted or sent something, and how it was answered. */
const asked = (m: AssistantMessage) =>
  (m.confirms ?? []).map((q) => `[asked: "${q.question}" → ${q.status === "waiting" ? "not answered yet" : q.status === "no" ? "the user said no" : q.status === "done" ? `yes, done${q.result ? `: ${q.result}` : ""}` : `yes, but it failed: ${q.result ?? ""}`}]`);

/** What a reply started or opened, with its page, so "show me" a few messages later has somewhere to go. */
const cards = (m: AssistantMessage) => (m.work ?? []).map((w) => `[${w.status === "running" ? "started" : w.status === "failed" ? "failed" : "made"}: ${w.title} → ${w.href}]`);

/** An earlier message's attachments, by count and name only: their files went with that turn. */
const marks = (m: AssistantMessage) =>
  [...cards(m), ...asked(m), m.images?.length ? `[${m.images.length === 1 ? "1 picture" : `${m.images.length} pictures`}]` : "", ...(m.pasted ?? []).map((n) => `[pasted: ${n}]`), ...(m.files ?? []).map((f) => `[video: ${f.name}, file id ${f.id}]`), ...(m.folders ?? []).map((p) => `[folder: ${p}]`), ...(m.localFiles ?? []).map((p) => `[video on their computer: ${p}]`)].filter(Boolean).join(" ");

/** What came with the newest message, as facts: its files in the folder, the page it was sent from, what was highlighted. */
function newestFacts(input: TurnInput): string[] {
  const out: string[] = [];
  const n = input.images.length;
  if (n) out.push(`The user attached ${n === 1 ? "a picture" : `${n} pictures`}: ${input.images.map((im, i) => attachedName(im.name, i, IMAGE_EXT[im.type], input.dir)).join(", ")} (the Read tool shows a picture).`);
  for (const f of input.files) out.push(`The user attached ${f.mime.startsWith("audio/") ? "a recording" : "a video"}: "${f.name}" (${(f.size / 1048576).toFixed(f.size < 10485760 ? 1 : 0)} MB), file id ${f.id}.`);
  for (const f of input.uploading ?? [])
    out.push(`The user attached a video still uploading from their phone: "${f.name}", file id ${f.id}. Go on with it now: use_file waits for it (and says when to call again), and a tool whose description says it takes videos still uploading takes it at once. Never wait for it yourself or ask the user to.`);
  for (const p of input.paths) out.push(`The user dropped a folder from their computer: ${JSON.stringify(p)} (its path there).`);
  for (const p of input.local) out.push(`The user dropped a video from their computer: ${JSON.stringify(p)} (its path there; nothing was uploaded).`);
  if (input.note) out.push(input.note);
  for (const [i, p] of input.pasted.entries()) out.push(`The user pasted "${p.name}" (${p.text.length.toLocaleString("en-US")} characters), in ${pastedName(p.name, i, input.dir)}.`);
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

/** The answers under the fit question (fitLine): the last one turns the question off (POST /turn). */
const FIT_NEW = "New project";
const FIT_OFF = "Don't ask again";
/** Told to the reply that answers "Don't ask again". */
const FIT_OFF_SAID = "That answer turned the question off (Settings, General has the switch): carry on in the open project.";
/** Asked when footage comes with a message and askFit is on (work-prefs; Settings, General). */
export const fitLine = (project: string) =>
  `The project open in the app is ${JSON.stringify(project)}. If the footage clearly doesn't belong there (by its file names, what the user said and, once read, what is said in it), say so in one line and offer_choices "${FIT_NEW}" / ${JSON.stringify(`Keep it in ${project}`)} / "${FIT_OFF}" ("${FIT_OFF}" turns this question off by itself).`;

/**
 * Told with every message sent while a project is open: which one, and its id. The tools that take a project use the
 * app's current one when they get none, and that may be another by the time a tool runs (the project is the account's,
 * not the chat's: picked for a new chat, it is picked for every chat).
 */
export const projectLine = (project: { id: string; name: string }) =>
  `The user's current project is ${JSON.stringify(project.name.replace(/\s+/g, " ").trim().slice(0, 60))} (id ${project.id}). Work in it unless they name another: give this id to a tool that takes a project.`;

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
  const asks = claude ? opts.onAsk : undefined;
  return ended(
    opts.turn,
    streamMacClaude(system + (opts.memory ?? ""), prompt, opts.cancel, (t) => opts.onDelta?.(t), undefined, {
      label: opts.label,
      background: opts.background,
      web: true, // the assistant may search and read the web, as the Workshop's writer does
      provider: { instance: route.instance.id, driver: route.instance.driver, home: route.instance.home, model: route.selection.model, effort: route.selection.effort, device: route.device, scope: route.scope, ...runFields(route.instance) },
      mcp: token ? { url, token } : undefined,
      files: opts.files,
      // what the reply needs to go on after a restart of the server (onAdopt below)
      keep: { kind: "assistant", username, turn: opts.turn, asks: !!asks, mac: fromMac.has(opts.turn), place: places.get(opts.turn) ?? 0 },
      ...hooksFor(username, opts.turn, asks),
    }),
  );
}

/** What a reply hears from the Mac's run, the same for a new answer and for one taken up after a restart. */
const hooksFor = (username: string, turn: string, onAsk?: (ask: MacAsk) => MacAskStatus) => ({
  // a turn waiting for an approval isn't counted toward its time limit (mac-claude.ts), so its token waits too
  onAsk: onAsk && ((ask: MacAsk) => {
    const status = onAsk(ask);
    if (status === "waiting") touchJobTokens(turn);
    return status;
  }),
  // Claude's own reads and searches; its MCP calls are noted by mcp.ts already, and "Thinking" is the reply's own status
  onStep: (label: string) => {
    if (label !== "Thinking" && !label.startsWith("mcp__")) noteStep(username, turn, label);
  },
});

/** An answer's end, either way: its token stops working, and never goes into a stored reply. */
async function ended(turn: string, answer: Promise<string>): Promise<string> {
  try {
    return await answer;
  } catch (e) {
    const limited = (e as { limited?: unknown } | null)?.limited;
    throw Object.assign(new Error((e instanceof Error ? e.message : String(e)).replace(/ctj_[a-f0-9]{48}/g, "")), limited ? { limited } : {});
  } finally {
    revokeJobTokens(turn);
  }
}

/**
 * Replies of one account written at the same time, each in its own chat (one chat writes one at a time). More wait, in
 * the order they were sent. Scheduled runs count too, but never wait (automations.ts already waits for a busy chat).
 * ponytail: per account, while the computer's relay runs 4 calls at once (mac-claude.ts MAC_SLOTS), shared with the
 * Workshop and editor jobs on it; a 4th or 5th call waits there up to 3 minutes, then fails. A per-computer count if that bites.
 */
export const MAX_RUNNING = 3;

/** The replies each account has being written now (by reply id, in whatever chat each is), for Stop and the cap. */
const running = new Map<string, Map<string, AbortController>>();
const runsOf = (username: string) => running.get(username) ?? running.set(username, new Map()).get(username)!;
/** Replies sent from the Mac app (their page context said so) while they are written: their open panel can choose a folder (askFolder). */
const fromMac = new Set<string>();
/**
 * The long texts pasted with the message a reply answers, while that reply is being written (pastedInChat).
 * ponytail: kept in this process only, so a reply that carries on after a restart has none (a style's words are then
 * taken from what was typed alone, as before pastes counted); keep them with the reply when that matters.
 */
const pastedFor = new Map<string, { ask: string; texts: string[] }>();

/**
 * Each reply being written has a place 0..MAX_RUNNING-1 of its own: the Mac writes every reply's pictures and pastes in
 * one assistant folder, so two at once would write over each other's "pasted/01-…". Place 0 keeps the plain paths, and
 * the folder holds at most MAX_RUNNING sets, each overwritten by the next reply in that place.
 */
const places = new Map<string, number>();
function placeOf(username: string, reply: string): string {
  const used = new Set([...runsOf(username).keys()].map((id) => places.get(id)));
  let n = 0;
  while (used.has(n)) n++;
  places.set(reply, n);
  return n ? `place-${n}/` : "";
}

/** One turn of the dock. */
const runTurn = (username: string, replyId: string, route: Route, url: string, prompt: string, files?: Record<string, string>, memory?: string, skills?: string): Promise<void> =>
  runReply(username, replyId, (run) => answerWithTools(username, route, url, prompt, { label: "Assistant", turn: replyId, files, memory, skills, ...run }));

/** The server restarted under a reply and it could not go on (nothing was running on the Mac yet, or the Mac is gone too). */
const RESTARTED = "The server restarted while this was being written. Send your message again.";

/** A scheduled run whose reply went on after a restart has ended: api/automations.ts records it (this file can't import that one). */
type RunEnded = (username: string, task: string, result: { status: "done" | "error"; text: string; chat?: string }) => void;
let runEnded: RunEnded | undefined;
export const setRunEnded = (fn: RunEnded): void => void (runEnded = fn);

/**
 * After a restart of the server: a reply the Mac is still writing goes on where it was, with its Stop, its place, its
 * approvals and its tools. A scheduled run's reply too. When: the Mac's next post about it arrives, its person
 * presses Stop, or a minute after boot (lib/mac-claude.ts adoptKept).
 */
onAdopt("assistant", (open) => {
  // every reply first: reading an account's chats (load) ends the replies in them that aren't running
  for (const { keep } of open) runsOf(String(keep.username)).set(String(keep.turn), new AbortController());
  for (const { id, keep } of open) {
    const [username, turn] = [String(keep.username), String(keep.turn)];
    places.set(turn, Number(keep.place) || 0);
    if (keep.mac) fromMac.add(turn);
    void runReply(username, turn, (run) =>
      ended(turn, (async () => {
        const answer = messageOf(username, turn)?.status === "thinking" ? adoptMacClaude(id, run.cancel, run.onDelta, hooksFor(username, turn, keep.asks ? run.onAsk : undefined)) : null;
        if (!answer) throw new Error(RESTARTED);
        return answer;
      })()),
    ).then(() => {
      const [task, m] = [taskOf(username, turn), messageOf(username, turn)];
      // stopped by a usage limit: nothing was kept to carry on with, so it waits for "Resume at reset" (its route keeps it)
      if (m?.limit?.resume) {
        m.limit.resume = undefined;
        save(username);
        tell(username);
      }
      if (task && m) runEnded?.(username, task.id, { status: m.status === "error" ? "error" : "done", text: m.text, chat: chatOfTurn(username, turn) ?? undefined });
    });
  }
});

/** A reply being written: it fills in as its answer streams, then its status says how it ended. */
async function runReply(username: string, replyId: string, answer: (run: { cancel: AbortSignal; onAsk: (ask: MacAsk) => MacAskStatus; onDelta: (text: string) => void }) => Promise<string>): Promise<void> {
  const stop = new AbortController();
  runsOf(username).set(replyId, stop);
  const started = Date.now();
  Object.assign(messageOf(username, replyId) ?? {}, { started });
  try {
    const text = await answer({
      cancel: stop.signal,
      onAsk: (ask) => approvalFor(username, replyId, ask),
      onDelta: (t) => {
        const m = messageOf(username, replyId);
        if (m) m.text = t;
        saveSoon(username, replyId);
      },
    });
    Object.assign(messageOf(username, replyId) ?? {}, { status: "done", text });
  } catch (e) {
    const m = messageOf(username, replyId);
    // stopped: what it had written stays, marked as stopped
    if (stop.signal.aborted) Object.assign(m ?? {}, { status: "done", text: m?.text ? `${m.text}\n\n*Stopped.*` : "*Stopped.*" });
    else Object.assign(m ?? {}, { status: "error", text: (e instanceof Error ? e.message : String(e)).slice(0, 300) || "The answer failed.", ...limitOf(username, e) });
  } finally {
    // what it asked and nobody answered can't be done any more
    const m = messageOf(username, replyId);
    if (m) {
      expireApprovals(m, 0);
      m.took = Date.now() - started;
      // stopped by a usage limit: put away till it resets, when the person asked for that (Settings)
      const chat = chatWith(load(username), replyId);
      if (chat && m.limit?.until && m.limit.until > Date.now() && readWorkPrefs(username).snoozeLimited) chat.snooze = { until: m.limit.until, at: Date.now() };
    }
    sayLater(username, replyId);
    runsOf(username).delete(replyId);
    fromMac.delete(replyId);
    pastedFor.delete(replyId);
    places.delete(replyId);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username, replyId);
    // the person hears it ended (a Stop is their own doing), and the next message's turn starts
    if (m && !stop.signal.aborted) attend(username, replyId, m.status === "error" ? "failed" : "done", m.text);
    void pump(username);
  }
}

/** A reply a usage limit stopped: when it resets, and whether the chat carries on by itself then (Settings, on by default). */
function limitOf(username: string, e: unknown): Pick<AssistantMessage, "limit"> {
  const limited = (e as { limited?: { until: number | null } } | null)?.limited;
  if (!limited) return {};
  const until = limited.until ?? undefined;
  return { limit: { ...(until ? { until } : {}), ...(until && readWorkPrefs(username).autoResume !== false ? { resume: true as const } : {}) } };
}

/** The chat a message is in, the open one included. */
const chatWith = (conv: Conv, id: string): Chat | undefined => [conv as Chat, ...(conv.past ?? [])].find((c) => c.messages.some((m) => m.id === id));

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
    chat: chat.id,
    kind,
    title: chat.title ?? titleOf(chat.messages),
    body: (line.length > 140 ? `${line.slice(0, 139)}…` : line) || (kind === "failed" ? "The answer failed." : "Answered."),
    path: `/?chat=${chat.id}`,
    sentAt: chat.messages.slice(0, i).reverse().find((m) => m.role === "user")?.at ?? chat.messages[i]!.at,
  });
}

/**
 * A turn that never started ends: stopped by the person (what it waited for is deleted here: nothing will use it), its
 * video never arrived, or the file it was to send isn't in the window any more (gone). The next one may start.
 */
function endHeld(username: string, m: AssistantMessage, how: "stopped" | "lost" | "gone"): void {
  const conv = load(username);
  const h = conv.held?.[m.id];
  const asked = everyChat(conv).flat().find((x) => x.id === h?.ask);
  if (conv.held) delete conv.held[m.id];
  // a `later` turn's videos go on up from the phone whatever happens to the reply: deleting them would only make it send parts to nothing
  if (how === "stopped" && !h?.later) for (const id of h?.files ?? []) void removeFile(username, id).catch((e) => console.warn("[assistant] remove a stopped upload:", e instanceof Error ? e.message : e));
  const lost = m.send ? [`"${m.send.name}"`] : (asked?.files ?? []).filter((f) => f.uploading).map((f) => `"${f.name}"`);
  const text =
    how === "stopped"
      ? "*Stopped.*"
      : how === "gone"
        ? `${lost[0]} isn't in this window any more (the page was reloaded): drop it in the chat again.`
        : m.send
          ? `${lost[0]} didn't arrive: drop it in the chat again.`
          : `${lost.length > 1 ? `${lost.join(" and ")} didn't arrive` : `${lost[0] ?? "A video"} didn't arrive`}, so this message wasn't answered: add ${lost.length > 1 ? "them" : "it"} again and send the message again.`;
  Object.assign(m, { status: how === "lost" ? "error" : "done", text, wait: undefined });
  sayLater(username, m.id);
  save(username);
  tell(username);
  if (how !== "stopped") attend(username, m.id, "failed", text);
}

// the uploads a waiting turn names stay through the orphan sweep: WAIT_MS ends that turn instead
setWaitedFor((username) => {
  const conv = load(username);
  const uploading = everyChat(conv).flat().flatMap((m) => (m.files ?? []).filter((f) => f.uploading).map((f) => f.id));
  return new Set([...Object.values(conv.held ?? {}).flatMap((h) => h.files), ...uploading]);
});

// a dropped file is whole: the messages that carry it stop saying it uploads, and a turn waiting for it may start
onFileIn.push((username, file) => {
  let changed = false;
  for (const m of everyChat(load(username)).flat())
    for (const f of m.files ?? [])
      if (f.id === file.id && f.uploading) {
        delete f.uploading;
        changed = true;
      }
  if (changed) {
    save(username);
    tell(username);
  }
  void pump(username);
});

const pumping = new Map<string, { again: boolean; done?: Promise<void> }>();
const wakes = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * The account's waiting turns, in order: each shows what it waits for, one whose video stopped arriving ends, and one
 * whose videos are all in starts once nothing is ahead of it in its chat and fewer than MAX_RUNNING replies are being written. Called whenever that may have changed (a turn
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
  const t = Date.now();
  let changed = false;
  let soonest = Infinity;
  // a reply a usage limit stopped, still the newest in its chat: once the limit resets (and the chat is no longer put
  // away), the chat says "Continue where you left off." by itself and that turn waits here like any other
  for (const [id, r] of Object.entries(conv.resume ?? {})) {
    const chat = chatWith(conv, id);
    const m = chat?.messages.at(-1);
    if (!chat || m?.id !== id || !m.limit?.until) {
      delete conv.resume![id];
      changed = true;
      continue;
    }
    if (!m.limit.resume || isSettled(conv, chat) || asking(conv, chat, t)) continue;
    const due = Math.max(m.limit.until, isSnoozed(conv, chat, t) ? chat.snooze!.until : 0);
    if (due > t) {
      soonest = Math.min(soonest, due);
      continue;
    }
    delete conv.resume![id];
    chat.snooze = undefined;
    const asked: AssistantMessage = { id: randomUUID(), role: "user", text: CONTINUE, at: t };
    const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: t + 1, status: "thinking" };
    chat.messages.push(asked, reply);
    (conv.held ??= {})[reply.id] = { ask: asked.id, files: [], pasted: [], ...r, at: t };
    changed = true;
  }
  const held = conv.held ?? {};
  // replies being written now, in every chat: up to MAX_RUNNING at once
  let busy = runsOf(username).size;
  // a chat with a reply that waits (for its videos, the reply before it, or a free place) holds the messages after it there: another chat goes on
  const stalled = new Set<AssistantMessage[]>();
  for (const id of Object.keys(held)) if (messageOf(username, id)?.status !== "thinking") {
    delete held[id];
    changed = true;
  }
  // in the order they were sent, in whatever chat each is now (New chat and opening an earlier one don't move them)
  for (const id of Object.keys(held)) {
    const h = held[id]!;
    const list = everyChat(conv).find((l) => l.some((m) => m.id === id))!;
    const i = list.findIndex((m) => m.id === id);
    const m = list[i]!;
    const asked = list.find((x) => x.id === h.ask);
    const inNow = (id: string) => {
      const f = files.get(id);
      return f && "file" in f ? f.file : null;
    };
    for (const f of asked?.files ?? []) if (f.uploading && inNow(f.id)) {
      delete f.uploading;
      changed = true;
    }
    // a send waits for the dock to start its upload first; a `later` turn starts while its videos go on uploading
    const missing = h.send && !h.files.length ? [""] : h.later ? [] : h.files.filter((id) => !inNow(id));
    // a scheduled run being written in its own chat goes first there too
    const runningBefore = list.slice(0, i).some((x) => x.status === "thinking" && !held[x.id]);
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
      wait = m.send
        ? { for: "videos", videos: 1, text: `Sending "${m.send.name}" to ${m.send.to}` }
        : { for: "videos", videos: missing.length, text: `Waiting for ${missing.length === 1 ? "a video" : `${missing.length} videos`} to upload` };
    } else if (runningBefore || stalled.has(list)) wait = { for: "reply", text: "Waiting for the reply before it" };
    else if (busy >= MAX_RUNNING) wait = { for: "reply", text: `Waiting: ${MAX_RUNNING} other chats are answering` };
    if (wait) {
      if (JSON.stringify(m.wait) !== JSON.stringify(wait)) {
        m.wait = wait;
        changed = true;
      }
      stalled.add(list);
      continue;
    }
    // one that can't start ends there, and the next may start in its place
    if (startHeld(username, conv, list, i, h, h.files.flatMap((id) => inNow(id) ?? []))) busy++;
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
function startHeld(username: string, conv: Conv, list: AssistantMessage[], i: number, h: Held, files: AssistantFile[]): boolean {
  const reply = list[i]!;
  const asked = list.find((x) => x.id === h.ask);
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
  const sent = h.send && files[0] ? `"${files[0].name}" is on this server now, file id ${files[0].id}: carry on, use_file with it to ${h.send}, then the rest of what the user asked.` : undefined;
  const uploading = (asked.files ?? []).filter((f) => f.uploading).map(({ id, name }) => ({ id, name }));
  const input: TurnInput = { text: asked.text, images, pasted: h.pasted, fileIds: h.files, files, uploading, paths: asked.folders ?? [], local: asked.localFiles ?? [], dir: placeOf(username, reply.id), context: h.context, note: sent ?? h.fit };
  if (h.context?.mac) fromMac.add(reply.id);
  if (h.pasted.length) pastedFor.set(reply.id, { ask: h.ask, texts: h.pasted.map((p) => p.text) });
  void runTurn(username, reply.id, route, h.url, promptFor(list.slice(0, i + 1), input), filesFor(input), h.memory, h.skills).then(() => {
    // a usage limit stopped it: what it needs to carry on when the limit resets (pump)
    if (!messageOf(username, reply.id)?.limit?.until) return;
    (load(username).resume ??= {})[reply.id] = { url: h.url, admin: h.admin, memory: h.memory, skills: h.skills };
    save(username);
    void pump(username);
  });
  return true;
}

/**
 * use_file on a file the user dropped in the Mac app (a path), from a reply in the dock, on a server that isn't on their
 * computer: the file has to be sent here first. A reply that carries on goes after this one, waiting for it (`send`); the
 * dock uploads that one file and names its upload (POST /sends/:reply). Its name; null when no chat has that reply or
 * nobody is at it (a scheduled run): the tool then answers as it would without a chat.
 */
export async function askSend(user: SessionUser, turn: string, url: string, p: string, to: AssistantFileUse): Promise<string | null> {
  const conv = load(user.username);
  const list = everyChat(conv).find((l) => l.some((m) => m.id === turn));
  const i = list?.findIndex((m) => m.id === turn) ?? -1;
  const asked = list?.slice(0, Math.max(i, 0)).reverse().find((m) => m.role === "user");
  if (!list || !asked || unattended(user.username, turn)) return null;
  const name = path.basename(p);
  // one send per file and tool while it waits
  if (list.some((m) => m.status === "thinking" && m.send?.path === p && m.send.to === USE_NAMES[to])) return name;
  if (everyChat(conv).flat().filter((m) => m.status === "thinking").length > MAX_WAITING) throw new Error("Too many messages are waiting for an answer: try again once they are answered.");
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: Date.now(), status: "thinking", send: { path: p, name, to: USE_NAMES[to] } };
  list.push(reply);
  (conv.held ??= {})[reply.id] = {
    ask: asked.id,
    files: [],
    pasted: [],
    memory: await memoryBlock(user),
    skills: skillLines(await dockSkills(user.username), "tool"),
    url,
    admin: user.role === "admin",
    at: reply.at,
    send: to,
  };
  save(user.username);
  void pump(user.username);
  return name;
}

/**
 * A minute after boot, when the process before this one is surely gone and every computer has posted about what it is
 * writing: a kept reply nobody posted about is taken up anyway (it then ends as "The Mac stopped answering" unless a
 * post comes), and a chat read while that process still answered is read again, since a reply may have ended there.
 */
export function settleAfterRestart(): void {
  adoptKept(() => true);
  for (const [username, conv] of [...cache]) {
    if (!everyChat(conv).flat().some((m) => m.status === "thinking" && !conv.held?.[m.id] && !runsOf(username).has(m.id))) continue;
    cache.delete(username);
    load(username);
    tell(username);
  }
}

/** At boot: the accounts whose conversation file has turns waiting carry on (a test calls it to stand for a restart). */
export function resumeFromDisk(): void {
  // answers kept for a caller that is gone are dropped; a reply's own waits for its computer's next post, since the
  // process before this one may still be answering it (a deploy's reload overlaps the two)
  dropUnowned();
  setTimeout(settleAfterRestart, SILENT_MS + 5_000).unref();
  let names: string[] = [];
  try {
    names = readdirSync(dirOf()).filter((f) => f.endsWith(".json"));
  } catch {
    return;
  }
  for (const f of names) {
    const text = readFileSync(path.join(dirOf(), f), "utf-8");
    if (!text.includes('"held":{"') && !text.includes('"resume":{"')) continue;
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
/**
 * The long texts the person pasted into the box with the message a reply answers (each went beside the message as a
 * file, never in its text), while that reply is being written. A style's own words may be taken from one, word for
 * word (api/editor/own-words.ts), and nothing else may: a quote to remember is checked against saidInChat alone. The
 * message is held to what typed words are held to: the person's own, in the chat the reply is written in, not a
 * scheduled task's prompt and not an answer button. A paste of an earlier message or of another chat is not here: the
 * texts are kept for the one reply they came with. null as saidInChat; empty when the message carried none.
 */
export function pastedInChat(username: string, turn: string): string[] | null {
  const list = everyChat(load(username)).find((l) => l.some((m) => m.id === turn && m.status === "thinking"));
  if (!list || unattended(username, turn)) return null;
  const kept = pastedFor.get(turn);
  const sent = list.filter((m) => m.status !== "thinking");
  const i = sent.findIndex((m) => m.id === kept?.ask);
  const asked = sent[i];
  if (!kept || !asked || asked.role !== "user" || asked.task || sent[i - 1]?.choices?.includes(asked.text)) return [];
  return kept.texts;
}

/**
 * The pictures the person sent in the chat a reply is being written in, oldest first: each one's id and its file. Null
 * when that reply is not being written, or nobody is there (a scheduled run). The assistant's animation_style_save
 * adds the newest of them to a style as inspirations (api/editor/animation-styles.ts).
 */
export function picturesInChat(username: string, turn: string): Array<{ id: string; file: string }> | null {
  const list = everyChat(load(username)).find((l) => l.some((m) => m.id === turn && m.status === "thinking"));
  if (!list || unattended(username, turn)) return null;
  return list
    .filter((m) => m.role === "user" && !m.task)
    .flatMap((m) => m.images ?? [])
    .flatMap((im) => {
      const found = imageFile(username, im.id);
      return found ? [{ id: im.id, file: found.file }] : [];
    });
}
/** The check a quote is held to against those; a style's own text is held to it too (api/editor/own-words.ts). */
export { foundIn } from "./lib/memory";

/** A reply is being written in this chat now: a run waits for it to end. */
export function chatBusy(username: string, chat: string | undefined): boolean {
  return chatOf(load(username), chat)?.messages.at(-1)?.status === "thinking";
}

/**
 * One scheduled run as a turn: the prompt goes in as the user's message (marked with its task), the reply streams in
 * under it, and the dock shows both like any other turn. `chat` is the chat to post in; gone or absent, a new chat
 * named after the task starts among the earlier chats (the open one is left alone). `fresh`: the reply sees only this
 * prompt, not the chat's earlier messages. Stop by its reply id stops it (in the open chat, the dock's Stop too). It runs
 * beside other chats' replies, counts toward MAX_RUNNING and never waits for it. Resolves with the chat and the
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
  tell(username, reply.id);
  const prompt = `${o.preface}\n\n${promptFor(o.fresh ? [asked] : chat.messages)}`;
  const stop = new AbortController();
  const chatId = chat.id; // `chat` may be the open one, whose id changes with a New chat
  runsOf(username).set(reply.id, stop);
  try {
    const text = await answerWithTools(username, o.route, o.url, prompt, {
      label: "Scheduled task",
      turn: reply.id,
      background: true,
      cancel: stop.signal,
      onDelta: (t) => {
        const m = messageOf(username, reply.id);
        if (m) m.text = t;
        saveSoon(username, reply.id);
      },
    });
    Object.assign(messageOf(username, reply.id) ?? {}, { status: "done", text });
    return { chat: chatId, text };
  } catch (e) {
    const why = stop.signal.aborted ? "Stopped." : (e instanceof Error ? e.message : String(e)).slice(0, 300) || "The run failed.";
    Object.assign(messageOf(username, reply.id) ?? {}, { status: stop.signal.aborted ? "done" : "error", text: why });
    throw new Error(why);
  } finally {
    Object.assign(messageOf(username, reply.id) ?? {}, { took: Date.now() - reply.at });
    sayLater(username, reply.id);
    runsOf(username).delete(reply.id);
    const t = pendingSave.get(username);
    if (t) clearTimeout(t);
    pendingSave.delete(username);
    save(username);
    tell(username, reply.id);
    // a message sent while it ran, in its chat, waited for it
    void pump(username);
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

/** A message in the open chat (POST /turn), or with `chatId` in that chat, which stays where it is (POST /chats/:id/turn). */
async function sendTurn(c: Context<{ Variables: AuthVars }>, chatId?: string) {
  const u = c.get("user");
  const target = () => (chatId === undefined ? (load(u.username) as Chat) : chatOf(load(u.username), chatId));
  if (!target()) return c.json({ error: "That conversation is gone" }, 404);
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
  // "Don't ask again" pressed under the fit question turns it off (only under that offer: the same words elsewhere don't)
  const lastReply = [...(target()?.messages ?? [])].reverse().find((m) => m.role === "assistant");
  const fitOff = input.text === FIT_OFF && !!lastReply?.choices?.includes(FIT_OFF) && lastReply.choices.includes(FIT_NEW);
  if (fitOff) writeWorkPrefs(u.username, { askFit: false });
  const project = await currentProject(u).catch(() => undefined);
  const footage = files.length || input.paths.length || input.local.length;
  // the project is named once: by the question whether dropped footage belongs there, else by its own line
  const fit = fitOff ? FIT_OFF_SAID : !project ? undefined : footage && readWorkPrefs(u.username).askFit !== false ? fitLine(project.name) : projectLine(project);
  const skills = skillLines(await dockSkills(u.username), "tool");
  const conv = load(u.username);
  if (everyChat(conv).flat().filter((m) => m.status === "thinking").length > MAX_WAITING) return c.json({ error: "Too many messages are waiting for an answer: wait for the replies" }, 409);
  // Before an AI is connected: no model call, no job, no paid call of any kind (the server's keys included).
  const route = routeOf(u.username, u.role === "admin");
  if (!route) return c.json({ error: "Connect your AI first", code: "NO_PROVIDER" }, 409);
  // read after the last await: a New chat meanwhile swaps what the open chat is
  const chat = target();
  if (!chat) return c.json({ error: "That conversation is gone" }, 404);
  const now = Date.now();
  // whoever sends has seen the chat up to here: the reply to this is unread until they look again
  chat.seen = now;
  // and is back at work in it: a chat put away till later is no longer away
  chat.snooze = undefined;
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
    ...(input.local.length ? { localFiles: input.local } : {}),
    ...(input.context?.selection ? { quote: input.context.selection } : {}),
  };
  const reply: AssistantMessage = { id: randomUUID(), role: "assistant", text: "", at: now + 1, status: "thinking" };
  chat.messages.push(asked, reply);
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
    ...(fit ? { fit } : {}),
    ...(input.later ? { later: true as const } : {}),
  };
  save(u.username);
  await pump(u.username);
  return c.json(view(u.username, u.role === "admin", chatId === undefined ? undefined : (chatOf(load(u.username), chatId) ?? undefined)), 202);
}

assistantApp.post("/turn", (c) => sendTurn(c));

/* ---- every chat by its id, none of them made the open one (the phone; the dock keeps the open chat) ---- */

assistantApp.get("/chats", (c) => c.json({ chats: chatList(c.get("user").username) }));

/** A new empty chat among the earlier ones (the open chat stays open): its id. */
assistantApp.post("/chats", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  const chat: Chat = { id: randomUUID(), messages: [], made: Date.now() };
  keepPast(u.username, conv, [chat, ...(conv.past ?? [])]);
  save(u.username);
  return c.json({ id: chat.id }, 201);
});

/**
 * Chats that have every word of ?q=: in the title first, then in what was said (a chat's newest message that has
 * them), newest first in each. { matches: [{ id, title, at, in: "title" | "user" | "assistant", snippet }] }.
 * Registered before /chats/:id, which would read "search" as an id.
 */
assistantApp.get("/chats/search", (c) => {
  const u = c.get("user");
  const words = (c.req.query("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.join("").length) return c.json({ error: "Say q: the words to find" }, 400);
  const conv = load(u.username);
  const has = (text: string) => words.every((w) => text.toLowerCase().includes(w));
  const all: Chat[] = [{ id: conv.id!, ...kept(conv), messages: conv.messages }, ...(conv.past ?? [])].filter((x) => x.messages.length);
  const row = (x: Chat, where: "title" | "user" | "assistant", text: string, at: number) => {
    const line = text.replace(/\s+/g, " ").trim();
    const hit = Math.max(0, line.toLowerCase().indexOf(words[0]!) - 60);
    return { id: x.id, title: x.title ?? titleOf(x.messages), at, in: where, snippet: `${hit ? "…" : ""}${line.slice(hit, hit + 240)}${line.length > hit + 240 ? "…" : ""}` };
  };
  const newest = (x: Chat) => x.messages.at(-1)?.at ?? 0;
  const byTitle = all.filter((x) => has(x.title ?? titleOf(x.messages))).sort((a, b) => newest(b) - newest(a));
  const bySaid = all
    .filter((x) => !byTitle.includes(x))
    .flatMap((x) => {
      const m = [...x.messages].reverse().find((m) => (m.role === "user" || m.role === "assistant") && has(m.text));
      return m ? [row(x, m.role as "user" | "assistant", m.text, m.at)] : [];
    })
    .sort((a, b) => b.at - a.at);
  return c.json({ matches: [...byTitle.map((x) => row(x, "title", x.title ?? titleOf(x.messages), newest(x))), ...bySaid].slice(0, 50) });
});

assistantApp.get("/chats/:id", (c) => {
  const u = c.get("user");
  const chat = chatOf(load(u.username), c.req.param("id"));
  return chat ? c.json(view(u.username, u.role === "admin", chat)) : c.json({ error: "That conversation is gone" }, 404);
});

assistantApp.post("/chats/:id/turn", (c) => sendTurn(c, c.req.param("id")));

/** Settle a chat (done with it, kept) or bring it back: { settled: boolean }. Every device's list folds it the same way. */
assistantApp.post("/chats/:id/settle", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { settled?: unknown } | null;
  if (typeof b?.settled !== "boolean") return c.json({ error: "Say settled: true or false" }, 400);
  const conv = load(u.username);
  const chat = chatOf(conv, c.req.param("id"));
  if (!chat) return c.json({ error: "That conversation is gone" }, 404);
  chat.settled = b.settled ? (chat.messages.at(-1)?.at ?? Date.now()) : undefined;
  // done with it: it is no longer pinned nor put away till later
  if (b.settled) chat.pinned = chat.snooze = undefined;
  save(u.username);
  tell(u.username);
  return c.json({ chats: chatList(u.username) });
});

/** A chat's own change from its menu in the list: what `change` does to it, then every device's list is told. */
async function changeChat(c: Context<{ Variables: AuthVars }>, change: (chat: Chat, body: Record<string, unknown>) => string | void) {
  const u = c.get("user");
  const body = ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
  const chat = chatOf(load(u.username), c.req.param("id"));
  if (!chat) return c.json({ error: "That conversation is gone" }, 404);
  const refused = change(chat, body);
  if (refused) return c.json({ error: refused }, 400);
  save(u.username);
  tell(u.username);
  return c.json({ chats: chatList(u.username) });
}

/** Pin a chat to the top of the list, or let it go: { pinned: boolean, at?: ms }. */
assistantApp.post("/chats/:id/pin", (c) =>
  changeChat(c, (chat, b) => {
    if (typeof b.pinned !== "boolean") return "Say pinned: true or false";
    // `at`: the place it had among the pinned (an undo puts it back there); else the newest pin, which is first
    chat.pinned = b.pinned ? (typeof b.at === "number" && b.at > 0 ? b.at : Date.now()) : undefined;
    // a pinned chat is one in use: it is neither settled nor put away
    if (b.pinned) chat.settled = chat.snooze = undefined;
  }),
);

/** Put a chat away until a time: { until: ms }, or bring it back now: { until: null }. Something new in it brings it back sooner. */
assistantApp.post("/chats/:id/snooze", (c) =>
  changeChat(c, (chat, b) => {
    if (b.until === null) return void (chat.snooze = undefined);
    if (typeof b.until !== "number" || !(b.until > Date.now())) return "Say until: a time to come (ms), or null";
    chat.snooze = { until: b.until, at: Date.now() };
  }),
);

/**
 * A reply a usage limit stopped, the chat's newest: { resume: true } carries on when the limit resets, false doesn't.
 * Its banner's "Resume at reset" and "Cancel auto-resume".
 */
assistantApp.post("/chats/:id/limit", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { resume?: unknown } | null;
  if (typeof b?.resume !== "boolean") return c.json({ error: "Say resume: true or false" }, 400);
  const found = () => {
    const m = chatOf(load(u.username), c.req.param("id"))?.messages.at(-1);
    return m?.limit?.until ? m : null;
  };
  if (!found()) return c.json({ error: "Nothing in that chat waits for a usage limit" }, 404);
  // a reply taken up after a restart kept nothing for this: it is made from this request, as a message's own would be
  const r: Resume | null = b.resume && !load(u.username).resume?.[found()!.id] ? { url: `${publicOrigin(c)}/api/mcp`, admin: u.role === "admin", memory: await memoryBlock(u), skills: skillLines(await dockSkills(u.username), "tool") } : null;
  const m = found();
  if (!m) return c.json({ error: "Nothing in that chat waits for a usage limit" }, 404);
  if (r) (load(u.username).resume ??= {})[m.id] = r;
  m.limit!.resume = b.resume ? true : undefined;
  save(u.username);
  tell(u.username);
  void pump(u.username);
  return c.json({ chats: chatList(u.username) });
});

/** Name a chat: { title }. */
assistantApp.post("/chats/:id/title", (c) =>
  changeChat(c, (chat, b) => {
    const title = typeof b.title === "string" ? b.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!title) return "A chat's name cannot be empty";
    chat.title = title;
  }),
);

/** Mark a chat as not looked at: its newest finished reply counts as new again (looking at the chat clears it). */
assistantApp.post("/chats/:id/unread", (c) =>
  changeChat(c, (chat) => {
    const m = [...chat.messages].reverse().find((x) => x.role === "assistant" && x.status !== "thinking");
    if (!m) return "Nothing was answered in it yet";
    chat.seen = (m.started ?? m.at) + (m.took ?? 0) - 1;
  }),
);

/** The person is looking at this chat now: what ended in it up to here is no longer unread (a quiet write, nobody is told). */
assistantApp.post("/chats/:id/seen", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  const chat = chatOf(conv, c.req.param("id"));
  if (!chat) return c.json({ error: "That conversation is gone" }, 404);
  chat.seen = Date.now();
  // one that came back from being put away has now been looked at: its "Woke" mark goes (every list is told)
  const woke = !!chat.snooze && !isSnoozed(conv, chat);
  if (woke) chat.snooze = undefined;
  save(u.username);
  if (woke) tell(u.username);
  return c.json({ ok: true });
});

/**
 * A new chat that carries on from one message: { from: message id } → { id, chats }. It holds the chat up to and with
 * that message (its pictures copied, so deleting one chat leaves the other's), first among the earlier chats; the one it
 * came from stays as it is. What waited for an answer there (a Yes / No, an Allow / Deny, an upload, a resume at a
 * limit's reset) stays there alone.
 */
assistantApp.post("/chats/:id/branch", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { from?: unknown } | null;
  const conv = load(u.username);
  const chat = chatOf(conv, c.req.param("id"));
  if (!chat) return c.json({ error: "That conversation is gone" }, 404);
  const end = chat.messages.findIndex((m) => m.id === b?.from);
  if (end < 0) return c.json({ error: "That message is gone" }, 404);
  const upTo = chat.messages.slice(0, end + 1);
  if (upTo.some((m) => m.status === "thinking")) return c.json({ error: "That reply is still being written" }, 400);
  const id = randomUUID();
  const answered = <T extends { status: string }>(xs?: T[]) => (xs?.some((x) => x.status !== "waiting") ? xs.filter((x) => x.status !== "waiting") : undefined);
  const messages = upTo.map((from) => {
    const m: AssistantMessage = { ...structuredClone(from), id: randomUUID() };
    m.approvals = answered(m.approvals);
    m.confirms = answered(m.confirms);
    m.send = undefined;
    m.wait = undefined;
    if (m.limit) m.limit = m.limit.until ? { until: m.limit.until } : {};
    if (m.images) m.images = m.images.map((im) => copyImage(u.username, im));
    return m;
  });
  keepPast(u.username, conv, [{ id, messages, title: chat.title ?? titleOf(chat.messages), seen: Date.now() }, ...(conv.past ?? [])]);
  save(u.username);
  tell(u.username);
  return c.json({ id, chats: chatList(u.username) });
});

/**
 * Stop a reply (the dock's Stop, or Steer to send a queued message now). { reply: id } stops that one: being written,
 * or waiting (for its videos, or its turn); without it, the one being written, else the first that waits. A waiting one
 * ends at once as stopped; the next waiting message carries on.
 */
assistantApp.post("/stop", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { reply?: unknown } | null;
  const conv = load(u.username);
  // a reply kept over a restart that its computer hasn't posted about yet is taken up now, so it can be stopped
  adoptKept((o) => o.keep.kind === "assistant" && o.keep.username === u.username);
  const runs = runsOf(u.username);
  // without a reply id: the open chat's own (a reply in any other chat is stopped by its id)
  const want = typeof b?.reply === "string" ? b.reply : (conv.messages.find((m) => runs.has(m.id)) ?? conv.messages.find((m) => m.status === "thinking" && conv.held?.[m.id]))?.id;
  const m = want && conv.held?.[want] ? messageOf(u.username, want) : undefined;
  if (m) {
    endHeld(u.username, m, "stopped");
    await pump(u.username);
    return c.json(view(u.username, u.role === "admin"));
  }
  const run = want ? runs.get(want) : undefined;
  if (!run) return c.json({ error: "Nothing is running" }, 404);
  run.abort();
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
  const asker = conv.pending.turn ? chatOfTurn(u.username, conv.pending.turn) : null;
  conv.pending = undefined;
  ((asker && chatOf(conv, asker)) || conv).messages.push({ id: randomUUID(), role: "note", text: `${spec.name} key saved (…${key.slice(-4)})`, at: Date.now() });
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/**
 * The dock's answer to a reply's send (askSend): { id } is the upload it started for that file (the reply carries on once it
 * is in), { gone: true } says the file isn't in that window any more (it was reloaded), and the reply says to drop it again.
 */
assistantApp.post("/sends/:reply", async (c) => {
  const u = c.get("user");
  const b = (await c.req.json().catch(() => null)) as { id?: unknown; gone?: unknown } | null;
  const conv = load(u.username);
  const reply = c.req.param("reply");
  const h = conv.held?.[reply];
  const m = messageOf(u.username, reply);
  if (!h?.send || !m?.send || m.send.id) return c.json({ error: "Nothing waits for that file" }, 404);
  if (b?.gone === true) endHeld(u.username, m, "gone");
  else {
    const id = typeof b?.id === "string" ? b.id : "";
    if (!(await uploadOf(u.username, id))) return c.json({ error: "No such upload" }, 400);
    h.files = [id];
    m.send.id = id;
    save(u.username);
  }
  await pump(u.username);
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

/** New chat: the conversation goes into the history and a fresh one starts. A reply still running or waiting there keeps writing into it. */
assistantApp.delete("/", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  archive(u.username, conv);
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** Back to an earlier conversation: the one on screen goes into the history, and this one carries on. */
assistantApp.post("/past/:id/open", (c) => {
  const u = c.get("user");
  const conv = load(u.username);
  const found = conv.past?.find((p) => p.id === c.req.param("id"));
  if (!found) return c.json({ error: "That conversation is gone" }, 404);
  conv.past = conv.past!.filter((p) => p !== found);
  archive(u.username, conv);
  Object.assign(conv, { id: found.id, ...kept(found), messages: found.messages });
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
  // a reply being written there stops; one waiting there is dropped by pump, and the next in line carries on
  for (const m of found.messages) runsOf(u.username).get(m.id)?.abort();
  save(u.username);
  void pump(u.username);
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
  conv.navigate = conv.navigateChat = undefined;
  save(u.username);
  return c.json(view(u.username, u.role === "admin"));
});

/** One of the caller's own pictures (a message's attachment); anyone else's, or a bad id, is not found. */
assistantApp.get("/images/:id", (c) => {
  const found = imageFile(c.get("user").username, c.req.param("id"));
  if (!found) return c.json({ error: "Not found" }, 404);
  return c.body(readFileSync(found.file), 200, { "content-type": found.type, "cache-control": "private, max-age=86400", "x-content-type-options": "nosniff" });
});
