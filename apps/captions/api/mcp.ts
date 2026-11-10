import { Hono } from "hono";
import { MY_KEYS } from "../contracts/service-keys";
import { TOOLS as APP_TOOLS, TOOL_NAMES, readiness, type SetupView } from "../contracts/tools";
import { CHECK, EDITORS, MAKES, TALK } from "../contracts/work-prefs";
import { EDIT_STEPS } from "../contracts/editor";
import { routeFor } from "./lib/providers";
import { deviceName } from "./lib/devices";
import { readConnectors } from "./lib/connectors/store";
import { myKeys } from "./my-keys";
import { askSecret, navigateTo, noteMedia, noteStep, noteWork } from "./assistant";
import { FILE_USES, type AssistantMedia, type AssistantWork } from "../contracts/assistant";
import { SESSION_STATUSES } from "./lib/workshop/types";
import { innerCall, jobTurn, type AuthVars } from "./auth";
import type { SessionUser } from "./users";
import type { ServerPlugin } from "./lib/plugin";

/**
 * Creator Toolset as a remote MCP server: POST /api/mcp, MCP's Streamable HTTP answered as plain JSON, no sessions. Only a Full AI key gets here
 * (boot.ts: the key is the account itself), sent as `Authorization: Bearer ctk_…` (claude.ai: the connector's
 * Request headers). Every tool calls the site's own routes with the caller's credentials, so each route's checks
 * stay the only checks. The assistant's job token (ctj_…, auth.ts) also gets here: it sees the same tools plus
 * ASSISTANT_DEFS, and only it may call those (isJob checks the header). A Full key sees TOOLS alone. The check is on
 * the header, not the account: a signed-in session that sends a ctj_ header can call them as its own account. That
 * is no wider than the account's own reach, since the tools only act for the account they run as.
 */

type Call = (path: string, init: RequestInit) => Promise<Response>;
type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };

class ToolError extends Error {}

/** The setup answers and, per tool (the picked ones, else all), what it still needs and what would add to it. */
function setupView(v: SetupView) {
  const tools = (v.tools ?? [...APP_TOOLS]).map((t) => {
    const r = readiness(t, v.have);
    return { id: t, name: TOOL_NAMES[t], ready: r.ready, missing: r.missing.map((n) => n.what), extra: r.extra.map((n) => n.what) };
  });
  return { picked: v.tools, plan: v.plan ?? v.detected, setupDone: v.done, tools };
}

/** The tools only the assistant's job token may call (the dock, assistant.ts). */
const ASSISTANT_TOOLS = new Set(["setup_status", "save_setup", "ask_secret", "navigate", "show_video", "use_file", "notes_get"]);
const isJob = (auth: Headers) => /^Bearer ctj_/.test(auth.get("authorization") ?? "");

/** MCP clients give up on a tool call after about a minute: a reply still thinking hands back its id to wait on. */
const WAIT_MAX_S = 55;

const INSTRUCTIONS = `Creator Toolset, as the signed-in user's account.

Content Workshop: the same projects, sessions, pieces and chat the user sees on the site and the iPhone app, so whatever
you do here shows there at once. A project is one brand (audience, voice, CTA). A session is one idea: its sources,
notes, pieces and chat, with a status (draft, writing, production, editing, toPost = ready to post, published,
shelved). A piece is one reel, carousel, ad, free, youtube script, newsletter, X thread or article: blocks (lines or slides, each with an id), hook
variations, a caption (post description) and a pinned comment. Two ways to write: workshop_chat asks the Workshop's
own writer, which reads the project, the user's posts and past rewrites (it runs on a paired Mac and can take minutes), or
change the text yourself with workshop_edit_piece. Locked blocks are ones the user approved: leave them as they are.

Review: his videos waiting for feedback, their versions and timed comments (with the frame each points at).
Resolve a comment only once the change it asks for is made. review_set_approval marks a video approved or sent back.

Instagram (the Analyzer): instagram_refresh starts a pull of one of the user's accounts (on their own Apify key or
official login), instagram_posts lists its posts since a date and the state of its pulls.

AI Editor: edits made from footage in the Media Library; each runs steps (analyze, script, draft, broll) into drafts,
one per version, which can be filed in Review.

How the user wants to work (get_work_prefs / set_work_prefs): where they talk to the AI (the app, their own AI chat, or
both) and where they check the work (the app, their own editor, or both).`;

const str = { type: "string" };
const schedule = {
  type: "object",
  properties: { kind: { type: "string", enum: ["daily", "weekly", "hours"] }, at: str, weekday: { type: "integer" }, every: { type: "integer" } },
  required: ["kind"],
};
const lines = { type: "array", items: { type: "object", properties: { id: str, text: str }, required: ["text"] } };
export const TOOLS = [
  { name: "workshop_projects", description: "The Workshop's projects (brands): id, name, audience, voice, CTA, notes.", inputSchema: { type: "object", properties: {} } },
  { name: "workshop_sessions", description: "Workshop sessions, newest first: id, title, status, project, pinned, posted.", inputSchema: { type: "object", properties: { project: { type: "string", description: "only this project's (id)" } } } },
  {
    name: "workshop_session",
    description: "One session: title, status, notes, sources, every piece with its blocks (ids and text), hooks, caption and pinned comment, and the last chat messages.",
    inputSchema: { type: "object", properties: { session: str, messages: { type: "integer", description: "how many recent chat messages (default 10)" } }, required: ["session"] },
  },
  {
    name: "workshop_new_session",
    description: "Start a session (in the current project unless one is named). It comes with one empty piece to write in.",
    inputSchema: { type: "object", properties: { title: str, project: str, notes: { type: "string", description: "the idea, what it's for, anything the writer should know" } }, required: ["title"] },
  },
  {
    name: "workshop_update_session",
    description: "Change a session's title, notes or status (moves it through the stages), or link its post: post_url (its Instagram link), or remove_post: true to unlink it.",
    inputSchema: {
      type: "object",
      properties: {
        session: str, title: str, notes: str, status: { type: "string", enum: [...SESSION_STATUSES] },
        post_url: str, remove_post: { type: "boolean" },
      },
      required: ["session"],
    },
  },
  {
    name: "workshop_new_piece",
    description: "Add another piece to a session; text becomes its first block (split it with workshop_edit_piece).",
    inputSchema: { type: "object", properties: { session: str, kind: { type: "string", enum: ["reel", "carousel", "ad", "free", "youtube", "newsletter", "thread", "article"] }, title: str, text: str }, required: ["session", "kind"] },
  },
  {
    name: "workshop_edit_piece",
    description: "Write in a piece yourself. blocks replaces the whole list in order: keep each kept block's id, leave id out for a new one, drop a block to delete it. Anything left out stays as it is.",
    inputSchema: { type: "object", properties: { session: str, piece: str, title: str, blocks: lines, hooks: lines, caption: str, pinned: str }, required: ["session", "piece"] },
  },
  {
    name: "workshop_chat",
    description: "Ask the Workshop's writer, in a session's chat, about one piece (it may edit the piece). Waits up to wait_s for the reply; if it's still thinking, call workshop_wait with the reply id.",
    inputSchema: {
      type: "object",
      properties: {
        session: str,
        piece: str,
        message: str,
        scope: { type: "string", enum: ["slight", "rewrite"], description: "how much it may change (unset = normal)" },
        wait_s: { type: "integer", description: `default and max ${WAIT_MAX_S}` },
      },
      required: ["session", "piece", "message"],
    },
  },
  { name: "workshop_wait", description: "Keep waiting for a workshop_chat reply.", inputSchema: { type: "object", properties: { session: str, reply: str, wait_s: { type: "integer" } }, required: ["session", "reply"] } },
  {
    name: "finals_link_session",
    description: "Link a Finals piece (its id) to the Workshop session, and optionally one of its pieces (workshop_piece), so Finals shows a post description per version there.",
    inputSchema: { type: "object", properties: { piece: str, session: str, workshop_piece: str }, required: ["piece", "session"] },
  },
  { name: "list_reviews", description: "His videos in Review: approval, versions, latest file, comment counts, link.", inputSchema: { type: "object", properties: {} } },
  {
    name: "get_review",
    description: "One review (its link or id, or a share link): each version, and every comment with its time, text, author, replies, resolved, drawing and references, plus the frames the open timed comments point at (drawing painted on).",
    inputSchema: { type: "object", properties: { link: str, version: { type: "integer" }, frames: { type: "integer", description: "how many comment frames to show (default 4, max 12)" } }, required: ["link"] },
  },
  {
    name: "resolve_comment",
    description: "Mark a Review comment done once the change it asks for is made (resolved: false reopens it).",
    inputSchema: { type: "object", properties: { link: str, comment_id: str, resolved: { type: "boolean" } }, required: ["link", "comment_id"] },
  },
  {
    name: "review_set_approval",
    description: "Set a Review video's approval: approved, changes (sent back to the editor), or in_progress / needs_review / none.",
    inputSchema: { type: "object", properties: { link: str, status: { type: "string", enum: ["none", "in_progress", "needs_review", "changes", "approved"] } }, required: ["link", "status"] },
  },
  {
    name: "review_share",
    description: "A Review video's public share link (anyone with it can watch and comment, no account), as the Share button on its page: on (default true) turns the link on and returns it, the same link each time; false turns it off. download lets viewers download the file. Make one only when the user asks for a link to share.",
    inputSchema: { type: "object", properties: { link: str, on: { type: "boolean" }, download: { type: "boolean" } }, required: ["link"] },
  },
  {
    name: "instagram_refresh",
    description: "Start a pull of one of the user's Analyzer accounts (by handle): its catalog of posts, profile, stats or tags. It runs in the background; instagram_posts shows the state.",
    inputSchema: { type: "object", properties: { account: str, types: { type: "array", items: { type: "string", enum: ["profile", "catalog", "stats", "tags"] } } }, required: ["account"] },
  },
  {
    name: "instagram_posts",
    description: "An Analyzer account's posts (by handle) taken on or after since (a date, like 2026-10-01): shortcode, url, kind, when, caption, plays, likes, comments, and the state of its pulls.",
    inputSchema: { type: "object", properties: { account: str, since: str }, required: ["account"] },
  },
  { name: "editor_list", description: "AI Editor edits, newest first: id, name, the last step and its state.", inputSchema: { type: "object", properties: {} } },
  { name: "editor_get", description: "One AI Editor edit: its brief, drafts, notes and jobs.", inputSchema: { type: "object", properties: { edit: str }, required: ["edit"] } },
  {
    name: "editor_run",
    description: "Run an AI Editor edit from a step on (analyze, script, draft, broll); send_to_review files a draft's preview in Review (needs draft).",
    inputSchema: { type: "object", properties: { edit: str, kind: { type: "string", enum: [...EDIT_STEPS, "send_to_review"] }, draft: str }, required: ["edit", "kind"] },
  },
  // automations (automations.ts): a prompt the account's own AI runs on a schedule, reporting to the inbox
  { name: "automations_list", description: "The user's automations: name, schedule, prompt, enabled, next run, and the last result (done, error or skipped, with its text).", inputSchema: { type: "object", properties: {} } },
  {
    name: "automations_create",
    description: "Schedule a prompt to run on the user's AI (as if they typed it, with these tools). schedule: kind daily (at), weekly (weekday 0 Sunday to 6 Saturday, at) or hours (every 1 to 168). Times are in timezone (IANA, such as Europe/Berlin): required for daily and weekly, so ask if you don't know it. project = a Workshop project id.",
    inputSchema: {
      type: "object",
      properties: { name: str, schedule: schedule, prompt: str, timezone: str, project: str },
      required: ["name", "schedule", "prompt"],
    },
  },
  {
    name: "automations_update",
    description: "Change an automation (id): any of name, schedule, prompt, timezone, project (null clears it), enabled. A new schedule or turning it on counts the next run from now.",
    inputSchema: { type: "object", properties: { id: str, name: str, schedule: schedule, prompt: str, timezone: str, project: { type: ["string", "null"] }, enabled: { type: "boolean" } }, required: ["id"] },
  },
  { name: "automations_delete", description: "Delete an automation (id) for good.", inputSchema: { type: "object", properties: { id: str }, required: ["id"] } },
  { name: "automations_run", description: "Run an automation (id) now, as its schedule would. It runs in the background: its result lands in automations_list (last result) and the user's inbox.", inputSchema: { type: "object", properties: { id: str }, required: ["id"] } },
  { name: "get_work_prefs", description: "How the user wants to work: talk (app | chat | both), check (app | editor | both), their editor and what they make.", inputSchema: { type: "object", properties: {} } },
  {
    name: "set_work_prefs",
    description: "Change how the user wants to work. talk = where they talk to the AI (app, chat = their own AI chat, both); check = where they check the work (app, editor, both); editor = which video editor (or null); makes = what they make.",
    inputSchema: { type: "object", properties: { talk: { type: "string", enum: [...TALK] }, check: { type: "string", enum: [...CHECK] }, editor: { type: ["string", "null"], enum: [...EDITORS, null] }, makes: { type: "array", items: { type: "string", enum: [...MAKES] } } } },
  },
];

/** The assistant's tools (the dock, assistant.ts): listed and callable for its job token only, so a Full key's list stays TOOLS. */
const ASSISTANT_DEFS = [
  { name: "setup_status", description: "What is set up: the AI, connected logins, which API keys the user has saved (never their values), the project count, the tools the user picked and their plan, and for each tool what it still needs (missing) and what would add to it (extra).", inputSchema: { type: "object", properties: {} } },
  {
    name: "save_setup",
    description: "Save the user's answers: the tools they want to use (ids from setup_status), their AI plan, or that setup is done.",
    inputSchema: { type: "object", properties: { tools: { type: "array", items: { type: "string", enum: [...APP_TOOLS] } }, plan: { type: "string" }, done: { type: "boolean" } } },
  },
  {
    name: "ask_secret",
    description: "Ask the user for one API key. It opens a secure box in the chat; the key goes straight to the server, never to you. Pass only the key's name and why it's needed.",
    inputSchema: { type: "object", properties: { env: { type: "string", enum: MY_KEYS.map((k) => k.env) }, why: str }, required: ["env", "why"] },
  },
  { name: "navigate", description: "Open a page of the app for the user: a relative path such as /workshop or /settings/connectors.", inputSchema: { type: "object", properties: { path: str }, required: ["path"] } },
  {
    name: "show_video",
    description: "Play a video inside the chat, with a link to its page: a Review video (link: its link or id, as get_review takes; version: its number, default the newest ready one), or an AI Editor draft's preview (edit and draft, as editor_get lists them).",
    inputSchema: { type: "object", properties: { link: str, version: { type: "integer" }, edit: str, draft: str } },
  },
  {
    name: "use_file",
    description: "Send a video or recording to a tool: file = the id of one dropped in the chat, or path = a file on this computer (when the server runs on it; nothing is uploaded). to: notes = Video Notes (transcript, summary, takeaways, action items, chapters; follow it with notes_get), review = a Review video (then review_share for a link), captions = a Caption Studio project. name = a title for it (default the file's name). The same file can go to several.",
    inputSchema: { type: "object", properties: { file: str, path: str, to: { type: "string", enum: [...FILE_USES] }, name: str }, required: ["to"] },
  },
  {
    name: "notes_get",
    description: "A Video Note (use_file to: notes gives its id): status (processing with its step, ready, error), title, summary, takeaways, action items, chapters and quotes once ready. Waits up to 50 s while it processes.",
    inputSchema: { type: "object", properties: { id: str }, required: ["id"] },
  },
];

/** A plug-in's MCP tool: its listing (the shape of TOOLS) and the handler that answers it. */
export type PluginToolDef = { name: string; description: string; inputSchema: Args };
/** What a plug-in tool handler gets besides its arguments: the account it runs as, this server's address, and the site's routes as that account. */
export type PluginToolContext = { user: SessionUser; origin: string; api: ReturnType<typeof apiOf> };
export type PluginToolHandler = (args: Args, ctx: PluginToolContext) => Promise<unknown>;
export type PluginTools = { defs: PluginToolDef[]; handlers: Map<string, PluginToolHandler>; replaced: Set<string> };

/**
 * The plug-ins' MCP tools (a plugin's `tools: { defs, handlers, replaces }`), gathered once when the server boots. A tool whose name a
 * built-in or assistant tool already has throws, unless the same plug-in lists that built-in in `replaces`: its tool then answers the
 * name, and the built-in is left out of the list. `replaces` takes only TOOLS names, each by one plug-in, and the plug-in must serve a
 * tool of that name. A def with no handler throws. The boot refuses rather than shadowing a tool by accident.
 */
export function pluginToolsOf(plugins: ServerPlugin[]): PluginTools {
  const builtIn = new Set(TOOLS.map((t) => t.name));
  const taken = new Set<string>([...builtIn, ...ASSISTANT_DEFS.map((t) => t.name)]);
  const out: PluginTools = { defs: [], handlers: new Map(), replaced: new Set() };
  for (const plugin of plugins) {
    const { defs = [], handlers = {}, replaces = [] } = (plugin.tools ?? {}) as {
      defs?: PluginToolDef[];
      handlers?: Record<string, PluginToolHandler>;
      replaces?: string[];
    };
    const over = new Set(replaces);
    for (const name of over) {
      if (!builtIn.has(name)) throw new Error(`plug-in ${plugin.id}: ${name} is not a built-in tool it can replace`);
      if (out.replaced.has(name)) throw new Error(`plug-in ${plugin.id}: ${name} is already replaced by another plug-in`);
      if (!defs.some((d) => d.name === name)) throw new Error(`plug-in ${plugin.id}: replaces tool ${name} but serves no tool of that name`);
    }
    for (const def of defs) {
      if (out.handlers.has(def.name) || (taken.has(def.name) && !over.has(def.name))) throw new Error(`plug-in ${plugin.id}: tool ${def.name} is already served`);
      if (!Object.hasOwn(handlers, def.name)) throw new Error(`plug-in ${plugin.id}: tool ${def.name} has no handler`);
      if (over.has(def.name)) out.replaced.add(def.name);
      taken.add(def.name);
      out.defs.push(def);
      out.handlers.set(def.name, handlers[def.name]!);
    }
  }
  return out;
}

const pick = (row: Args, keys: string[]) => Object.fromEntries(keys.filter((k) => row[k] != null && row[k] !== "" && !(Array.isArray(row[k]) && !(row[k] as unknown[]).length)).map((k) => [k, row[k]]));
const linesOf = (blocks: unknown) => ((blocks as Args[] | undefined) ?? []).map((b) => ({ id: b.id, text: b.text }));
const piece = (d: Args) => ({
  ...pick(d, ["id", "kind", "title", "locked"]),
  blocks: linesOf(d.blocks),
  ...((d.hooks as unknown[] | undefined)?.length ? { hooks: linesOf(d.hooks) } : {}),
  ...(d.caption ? { caption: (d.caption as Args).text } : {}),
  ...(d.pinned ? { pinned: (d.pinned as Args).text } : {}),
});
const message = (m: Args) => pick(m, ["id", "role", "text", "status", "error", "docId", "usage", "edits"]);
const clock = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toFixed(2).padStart(5, "0")}`;
const when = (ms: unknown) => (typeof ms === "number" && ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : undefined);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A review link or id → its API path (the user's own, a share link's, or a shared folder's video). */
function reviewPath(link: string, origin: string): string {
  const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
  const p = (() => {
    try {
      return new URL(link, origin).pathname;
    } catch {
      return link;
    }
  })();
  for (const [re, api] of [
    [new RegExp(`^/?(${uuid})/?$`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/review/(${uuid})`, "i"), (a: string[]) => `/api/review/assets/${a[0]}`],
    [new RegExp(`/r/(${uuid})`, "i"), (a: string[]) => `/api/review/s/${a[0]}`],
    [new RegExp(`/rp/(${uuid})/(${uuid})`, "i"), (a: string[]) => `/api/review/p/${a[0]}/a/${a[1]}`],
  ] as const) {
    const m = re.exec(p) ?? re.exec(link);
    if (m) return api(m.slice(1));
  }
  throw new ToolError(`That isn't a review link: expected ${origin}/review/<id>, /r/<token> or /rp/<token>/<id>.`);
}

/** The site's own routes, called with the caller's credentials: every tool's calls go through here, so each route's checks stay the only checks. */
function apiOf(call: Call, auth: Headers) {
  return async (path: string, method = "GET", body?: unknown): Promise<Response> => {
    const headers = new Headers();
    for (const h of ["authorization", "cookie"]) if (auth.get(h)) headers.set(h, auth.get(h)!);
    if (body !== undefined) headers.set("content-type", "application/json");
    const r = await call(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 404) throw new ToolError("Not found, or not this account's.");
    if (!r.ok) {
      const j = (await r.json().catch(() => null)) as { error?: string } | null;
      throw new ToolError(j?.error || `${path} answered ${r.status}`);
    }
    return r;
  };
}

/** The tools, each a thin client of the site's own routes with the caller's credentials. */
function tools(call: Call, auth: Headers, origin: string, user: SessionUser) {
  const api = apiOf(call, auth);
  const json = async <T = Args>(path: string, method = "GET", body?: unknown) => (await (await api(path, method, body)).json()) as T;
  const ws = <T = Args>(path: string, method = "GET", body?: unknown) => json<T>(`/api/workshop${path}`, method, body);
  /** An Analyzer account of the user's by handle → its id (the account routes take the id). */
  const accountOf = async (handle: string) => {
    const name = handle.replace(/^@/, "").toLowerCase();
    const found = (await json<Args[]>(`/api/instagram/accounts?q=${encodeURIComponent(name)}`)).find((a) => String(a.username ?? "").toLowerCase() === name);
    if (!found) throw new ToolError(`No account of yours is called @${name}: add it in the Analyzer first.`);
    return String(found.id);
  };
  const pieces = async (session: string) => (await ws<Args[]>(`/sessions/${session}/docs`)).filter((d) => d.kind !== "notes").map(piece);

  const wait = async (a: Args) => {
    const end = Date.now() + Math.max(0, Math.min(Number(a.wait_s ?? WAIT_MAX_S), WAIT_MAX_S)) * 1000;
    for (;;) {
      const msg = (await ws<Args[]>(`/sessions/${a.session}/chat`)).find((m) => m.id === a.reply);
      if (!msg) throw new ToolError("That reply isn't in this session's chat.");
      if (msg.status !== "thinking" || Date.now() >= end) {
        if (msg.status === "thinking") return { reply: message(msg), note: `Still thinking (${msg.stage ?? "working"}): call workshop_wait again.` };
        return { reply: message(msg), ...(msg.docId ? { piece: piece(await ws(`/sessions/${a.session}/docs/${msg.docId}`)) } : {}) };
      }
      await sleep(3000);
    }
  };

  const handlers: Record<string, (a: Args) => Promise<unknown>> = {
    workshop_projects: async () => ({ projects: (await ws<Args[]>("/projects")).map((p) => pick(p, ["id", "name", "audience", "voice", "cta", "notes"])) }),
    workshop_sessions: async (a) => ({
      sessions: (await ws<Args[]>(`/sessions${a.project ? `?projectId=${encodeURIComponent(String(a.project))}` : ""}`)).map((r) =>
        pick(r, ["id", "title", "status", "projectId", "projectName", "pinned", "posted", "updatedAt"]),
      ),
    }),
    workshop_session: async (a) => {
      const meta = await ws(`/sessions/${a.session}`);
      const chat = await ws<Args[]>(`/sessions/${a.session}/chat`);
      const n = Math.max(0, Number(a.messages ?? 10));
      return {
        ...pick(meta, ["id", "title", "status", "projectId", "notes", "query", "posted"]),
        sources: ((meta.posts as Args[] | undefined) ?? []).map((p) => pick(p, ["id", "url", "caption"])),
        pieces: await pieces(String(a.session)),
        chat: n ? chat.slice(-n).map(message) : [],
      };
    },
    workshop_new_session: async (a) => {
      const made = await ws("/sessions", "POST", { title: a.title, ...(a.project ? { projectId: a.project } : {}), ...(a.notes ? { notes: a.notes } : {}) });
      // opening it makes its Notes and the empty piece to write in, as the site does
      return { ...pick(made, ["id", "title", "status", "projectId"]), pieces: await pieces(String(made.id)) };
    },
    workshop_update_session: async (a) => {
      const body: Args = pick(a, ["title", "notes", "status"]);
      // through the session's own PATCH, so the link is checked as it is from the app
      if (a.remove_post === true) body.posted = null;
      else if (a.post_url) body.posted = a.post_url;
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give a title, notes, status or a post.");
      return pick(await ws(`/sessions/${a.session}`, "PATCH", body), ["id", "title", "status", "posted"]);
    },
    workshop_new_piece: async (a) => piece(await ws(`/sessions/${a.session}/docs`, "POST", pick(a, ["kind", "title", "text"]))),
    workshop_edit_piece: async (a) => {
      const body = pick(a, ["title", "blocks", "hooks", "caption", "pinned"]);
      if (!Object.keys(body).length) throw new ToolError("Nothing to change.");
      return piece(await ws(`/sessions/${a.session}/docs/${a.piece}`, "PATCH", body));
    },
    workshop_chat: async (a) => {
      const started = await ws<{ reply: Args }>(`/sessions/${a.session}/chat`, "POST", { docId: a.piece, text: a.message, ...(a.scope ? { scope: a.scope } : {}) });
      return wait({ session: a.session, reply: started.reply.id, wait_s: a.wait_s });
    },
    workshop_wait: wait,
    finals_link_session: async (a) =>
      ws(`/sessions/${a.session}/finals`, "POST", { pieceId: a.piece, ...(a.workshop_piece ? { docId: a.workshop_piece } : {}) }),
    list_reviews: async () => ({
      reviews: (await json<Args[]>("/api/review")).map((r) => {
        const versions = (r.versions as Args[] | undefined) ?? [];
        return {
          ...pick(r, ["id", "name"]),
          approval: (r.approval as Args | undefined)?.status,
          versions: versions.length,
          latest_file: versions.at(-1)?.name,
          latest_comments: r.comments,
          new_comments: r.newComments,
          updated: when(r.updatedAt),
          link: `${origin}/review/${r.id}`,
        };
      }),
    }),
    get_review: async (a) => {
      const path = reviewPath(String(a.link), origin);
      const view = await json(path);
      const asset = view.asset as Args;
      const versions = new Map(((asset.versions as Args[] | undefined) ?? []).map((v) => [v.n as number, v]));
      const all = (view.comments as Args[] | undefined) ?? [];
      const threads = all
        .filter((c) => !c.parentId && (a.version == null || c.version === Number(a.version)))
        .sort((x, y) => (Number(x.version) - Number(y.version)) || ((x.t as number) ?? -1) - ((y.t as number) ?? -1))
        .map((c): Args => {
          const fps = Number(versions.get(c.version as number)?.fps) || 0;
          const points = ((c.drawing as Args[] | undefined) ?? []).flatMap((s) => (s.points as number[][] | undefined) ?? []);
          return {
            ...pick(c, ["id", "version", "text", "author", "resolved"]),
            when: when(c.createdAt),
            ...(typeof c.t === "number" ? { at: clock(c.t) + (typeof c.tEnd === "number" ? `–${clock(c.tEnd)}` : ""), start: c.t, end: c.tEnd, ...(fps ? { frame: Math.round(c.t * fps) } : {}) } : {}),
            ...(points.length ? { drawing_box: [Math.min(...points.map((p) => p[0]!)), Math.min(...points.map((p) => p[1]!)), Math.max(...points.map((p) => p[0]!)), Math.max(...points.map((p) => p[1]!))] } : {}),
            ...((c.refs as Args[] | undefined)?.length ? { references: (c.refs as Args[]).map((r) => pick(r, ["id", "name", "kind"])) } : {}),
            replies: all.filter((r) => r.parentId === c.id).map((r) => ({ author: r.author, text: r.text, when: when(r.createdAt) })),
          };
        });
      const shaped = {
        ...pick(asset, ["id", "name"]),
        link: `${origin}/review/${asset.id}`,
        approval: (asset.approval as Args | undefined)?.status,
        versions: [...versions.values()].map((v) => pick(v, ["n", "name", "duration", "fps", "width", "height", "status", "removed"])),
        open_comments: threads.filter((t) => !t.resolved).length,
        comments: threads,
      };
      const out: Content[] = [{ type: "text", text: JSON.stringify(shaped, null, 1) }];
      const timed = threads.filter((t) => "start" in t && !t.resolved && !versions.get(t.version as number)?.removed);
      for (const t of timed.slice(0, Math.max(0, Math.min(Number(a.frames ?? 4), 12)))) {
        const r = await api(`${path}/v/${t.version}/frame?c=${encodeURIComponent(String(t.id))}`).catch(() => null);
        if (!r) continue;
        out.push({ type: "text", text: `Comment ${t.id} (v${t.version}, ${t.at}): ${t.text}` });
        out.push({ type: "image", mimeType: "image/jpeg", data: Buffer.from(await r.arrayBuffer()).toString("base64") });
      }
      return out;
    },
    resolve_comment: async (a) => {
      const id = ((await json(reviewPath(String(a.link), origin))).asset as Args).id;
      const cm = await json(`/api/review/assets/${id}/comments/${encodeURIComponent(String(a.comment_id))}`, "PATCH", { resolved: a.resolved !== false });
      return { id: cm.id, resolved: !!cm.resolved, text: cm.text };
    },
    use_file: async (a) => {
      // what the tool still needs comes first: the assistant asks for it (ask_secret, a Settings page), then tries again
      const tool = a.to === "review" ? "review" : a.to === "captions" ? "captions" : "notes";
      const { missing } = readiness(tool, (await json<SetupView>("/api/setup")).have);
      if (missing.length)
        return {
          not_yet: `${TOOL_NAMES[tool]} needs these first; then call use_file again.`,
          needs: missing.map((n) => ({ what: n.what, ...(n.form === "keys" ? { ask_secret: n.anyOf } : { open: n.form === "ai" ? "/settings/providers" : "/settings/general" }) })),
        };
      if (!a.file && !a.path) throw new ToolError("Give the dropped file's id, or a path on this computer.");
      const file = a.path ? (await json(`/api/assistant/files/path`, "POST", { path: a.path })).id : a.file;
      return json(`/api/assistant/files/${encodeURIComponent(String(file))}/use`, "POST", pick(a, ["to", "name"]));
    },
    notes_get: async (a) => {
      const path = `/api/clips/${encodeURIComponent(String(a.id))}`;
      // GET /api/clips/:id also answers a shared note's link: only this account's own here
      const mine = (n: Args) => {
        if (n.owner !== user.username && user.role !== "admin") throw new ToolError("Not found, or not this account's.");
        return n;
      };
      let n = mine(await json(path));
      for (let t = 0; n.status === "processing" && t < 25; t++) n = (await sleep(2000), mine(await json(path)));
      const blocks = Object.fromEntries(((n.blocks as Args[] | undefined) ?? []).map((b) => [b.kind, b.text ?? ((b.items as Args[] | undefined) ?? []).map((x) => x.text)]));
      return {
        ...pick(n, ["id", "name", "status", "step", "error"]),
        link: `${origin}/video-notes/${n.id}`,
        ...(n.status === "processing" ? { note: "Still processing: call notes_get again." } : {}),
        ...(n.status === "ready" && !n.hasTranscript ? { note: "No transcript: the file has no speech, or this account's cloud transcription is off (an admin switches it on)." } : {}),
        ...blocks,
        ...((n.chapters as Args[] | undefined)?.length ? { chapters: (n.chapters as Args[]).map((c) => `${clock(Number(c.t))} ${c.title}`) } : {}),
      };
    },
    review_set_approval: async (a) => {
      const id = ((await json(reviewPath(String(a.link), origin))).asset as Args).id;
      const r = await json(`/api/review/assets/${id}/approval`, "POST", { status: a.status });
      return { id: r.id, name: r.name, approval: (r.approval as Args | undefined)?.status };
    },
    review_share: async (a) => {
      const id = ((await json(reviewPath(String(a.link), origin))).asset as Args).id;
      const share = { enabled: a.on !== false, ...(typeof a.download === "boolean" ? { download: a.download } : {}) };
      const r = await json(`/api/review/assets/${id}`, "PATCH", { share });
      const s = r.share as { token: string; enabled: boolean; download: boolean };
      if (!s.enabled) return { name: r.name, shared: false };
      // a server on this Mac with no address on the internet: the link opens here only
      const here = process.env.CT_LOCAL === "1" && !process.env.PUBLIC_ORIGIN;
      return { name: r.name, share_link: `${origin}/r/${s.token}`, download: s.download, ...(here ? { note: "This link opens only on this computer and its network. For other people the server needs an address on the internet (PUBLIC_ORIGIN: the name of a tunnel that points at it)." } : {}) };
    },
    instagram_refresh: async (a) => {
      const id = await accountOf(String(a.account));
      const types = Array.isArray(a.types) && a.types.length ? a.types : ["catalog"];
      return pick(await json(`/api/instagram/accounts/${id}/jobs`, "POST", { types }), ["id", "username", "jobs", "catalogCount"]);
    },
    instagram_posts: async (a) => {
      const sinceMs = a.since ? Date.parse(String(a.since)) : 0;
      if (Number.isNaN(sinceMs)) throw new ToolError("since is a date, like 2026-10-01.");
      const acc = await json(`/api/instagram/accounts/${await accountOf(String(a.account))}`);
      const rows = ((acc.catalog as Args[] | undefined) ?? []).filter((r) => (r.takenAt as number) >= sinceMs).sort((x, y) => (y.takenAt as number) - (x.takenAt as number));
      return {
        account: acc.username,
        jobs: acc.jobs,
        posts: rows.map((r) => ({
          ...pick(r, ["shortcode", "url", "kind"]),
          when: when(r.takenAt),
          caption: String(r.caption ?? r.captionPreview ?? "").slice(0, 300),
          ...pick((r.counts ?? {}) as Args, ["plays", "likes", "comments"]),
        })),
      };
    },
    editor_list: async () => ({
      edits: (await json<Args[]>("/api/editor")).map((e) => ({ ...pick(e, ["id", "name", "last"]), updated: when(e.updatedAt), link: `${origin}/editor/${e.id}` })),
    }),
    editor_get: async (a) => {
      const e = await json(`/api/editor/${encodeURIComponent(String(a.edit))}`);
      return {
        ...pick(e, ["id", "name", "brief", "script", "versions", "drafts", "notes"]),
        link: `${origin}/editor/${e.id}`,
        jobs: ((e.jobs as Args[] | undefined) ?? []).slice(-10).map((j) => pick(j, ["id", "kind", "variant", "state", "error"])),
      };
    },
    editor_run: async (a) => {
      const edit = encodeURIComponent(String(a.edit));
      if (a.kind === "send_to_review") {
        if (!a.draft) throw new ToolError("send_to_review needs the draft's name (editor_get lists them).");
        await json(`/api/editor/${edit}/drafts/${encodeURIComponent(String(a.draft))}/review`, "POST", {});
        return { status: "queued", draft: a.draft };
      }
      await json(`/api/editor/${edit}/run`, "POST", { from: a.kind });
      return { status: "queued", from: a.kind };
    },
    automations_list: async () => ({ automations: (await json<{ items: Args[] }>("/api/automations")).items }),
    automations_create: async (a) => json("/api/automations", "POST", pick(a, ["name", "schedule", "prompt", "timezone", "project"])),
    automations_update: async (a) => {
      const body = pick(a, ["name", "schedule", "prompt", "timezone", "project", "enabled"]);
      if (a.project === null) body.project = null;
      return json(`/api/automations/${encodeURIComponent(String(a.id))}`, "PATCH", body);
    },
    automations_delete: async (a) => json(`/api/automations/${encodeURIComponent(String(a.id))}`, "DELETE"),
    automations_run: async (a) => json(`/api/automations/${encodeURIComponent(String(a.id))}/run`, "POST"),
    get_work_prefs: async () => json("/api/work-prefs"),
    set_work_prefs: async (a) => {
      const body = pick(a, ["talk", "check", "makes"]);
      if (a.editor !== undefined) body.editor = a.editor;
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give talk, check, editor or makes.");
      return json("/api/work-prefs", "PUT", body);
    },
    setup_status: async () => {
      const route = routeFor(user.username, user.role === "admin", "notes");
      const keys = myKeys(user.username);
      const projects = await ws<Args[]>("/projects");
      return {
        ai: route
          ? { connected: true, name: route.instance.name, driver: route.instance.driver, on: deviceName(route.device) }
          : { connected: false, note: "No AI yet: connect Claude Code on a paired Mac (Settings → Your own AI)." },
        logins: readConnectors(user.username).accounts.map((a) => ({ platform: a.platform, handle: a.handle, via: a.via })),
        keys: MY_KEYS.map((k) => ({ env: k.env, name: k.name, what: k.what, saved: !!keys[k.env] })),
        projects: projects.length,
        ...setupView(await json<SetupView>("/api/setup")),
      };
    },
    save_setup: async (a) => setupView(await json<SetupView>("/api/setup", "PUT", pick(a, ["tools", "plan", "done"]))),
    ask_secret: async (a) => {
      const env = MY_KEYS.find((k) => k.env === a.env);
      if (!env) throw new ToolError(`${String(a.env)} is not a key the app takes.`);
      // only the name and the reason: any other argument (a value included) is dropped unread
      await askSecret(user.username, env.env, String(a.why ?? "").slice(0, 300));
      return { status: "asked", note: "The user will type the key into a secure box in the chat. It does not come to you; carry on without it until it's saved." };
    },
    navigate: async (a) => ({ status: "opening", path: await navigateTo(user.username, String(a.path ?? "")) }),
    // the card's src and href are the site's own routes, so the browser's cookie passes the same checks this call did
    show_video: async (a) => {
      let link = a.link;
      let version = a.version;
      if (a.edit || a.draft) {
        // this editor files each draft's preview in Review: the draft plays from there
        if (!a.edit || !a.draft) throw new ToolError("An AI Editor preview needs edit and draft (editor_get lists them).");
        const e = await json(`/api/editor/${encodeURIComponent(String(a.edit))}`);
        const p = ((e.previews as Record<string, { assetId: string; n: number }> | undefined) ?? {})[String(a.draft)];
        if (!p) throw new ToolError("That draft has no preview yet: editor_run kind preview renders one.");
        [link, version] = [p.assetId, p.n];
      }
      if (!link) throw new ToolError("Give the Review video's link or id, or an edit and draft.");
      const path = reviewPath(String(link), origin);
      const asset = (await json(path)).asset as Args;
      const versions = ((asset.versions as Args[] | undefined) ?? []).filter((v) => !v.removed);
      const v = version != null ? versions.find((x) => x.n === Number(version)) : versions.filter((x) => x.status === "ready").at(-1);
      if (!v) throw new ToolError(version != null ? `This video has no version ${version}.` : "This video has no version ready to play yet.");
      if (v.status !== "ready") throw new ToolError(`Version ${v.n} is ${v.status === "error" ? "broken" : "still processing"}.`);
      // the page that opens it: the owner's /review/<id>, or the share link's own page
      const page = path.replace(/^\/api\/review\/assets\//, "/review/").replace(/^\/api\/review\/s\//, "/r/").replace(/^\/api\/review\/p\/([^/]+)\/a\//, "/rp/$1/");
      const card: AssistantMedia = {
        id: `review:${asset.id}:${v.n}`,
        kind: "video",
        title: versions.length > 1 ? `${asset.name} · version ${v.n}` : String(asset.name),
        src: `${path}/v/${v.n}/play`,
        poster: `${path}/v/${v.n}/thumb`,
        href: `${page}?v=${v.n}`,
        ...(Number(v.duration) ? { duration: Number(v.duration) } : {}),
      };
      const turn = jobTurn(auth.get("authorization") ?? undefined);
      if (turn) noteMedia(user.username, turn, card);
      // the player is in the chat already: the reply needs only what it shows
      return { showing: card.title, page: card.href };
    },
  };
  return handlers;
}

/** What a tool call looks like to the person watching the assistant work (noteStep). */
const STEPS: Record<string, string> = {
  setup_status: "Checking what's set up",
  show_video: "Showing the video",
  use_file: "Sending your file",
  notes_get: "Reading the Video Note",
  save_setup: "Saving your setup",
  ask_secret: "Asking for a key",
  get_work_prefs: "Checking how you like to work",
  set_work_prefs: "Saving how you like to work",
  workshop_projects: "Looking at your projects",
  workshop_sessions: "Looking through the Workshop",
  workshop_session: "Reading a Workshop session",
  finals_link_session: "Linking the session",
  workshop_new_session: "Starting a Workshop session",
  workshop_update_session: "Updating a Workshop session",
  workshop_new_piece: "Adding a piece",
  workshop_edit_piece: "Editing a piece",
  workshop_chat: "Asking the Workshop's writer",
  workshop_wait: "Waiting for the writer",
  list_reviews: "Looking through Review",
  get_review: "Checking the video in Review",
  resolve_comment: "Resolving a comment",
  review_set_approval: "Setting the approval",
  review_share: "Getting the share link",
  editor_list: "Looking at the AI Editor's edits",
  editor_get: "Opening the edit",
  editor_run: "Starting an AI Editor job",
  instagram_posts: "Reading your Instagram posts",
  instagram_refresh: "Refreshing Instagram",
  automations_list: "Looking at your automations",
  automations_create: "Making the automation",
  automations_update: "Changing the automation",
  automations_delete: "Deleting the automation",
  automations_run: "Running the automation",
};
const PAGES: Record<string, string> = { review: "Review", workshop: "the Workshop", editor: "the AI Editor", settings: "Settings", instagram: "the Analyzer", analyzer: "the Analyzer" };
export const stepFor = (name: string, args: Args): string =>
  name === "navigate"
    ? `Opening ${PAGES[String(args.path ?? "").split(/[/?]/)[1] ?? ""] ?? "the page"}`
    : (STEPS[name] ?? name.replace(/_/g, " "));

const WRITING = "The Workshop's writer is drafting";
const kindTitle = (kind: unknown) => String(kind ?? "job").replace(/^./, (c) => c.toUpperCase()).replace(/_/g, " ");

/**
 * The card a tool call leaves under the assistant's reply (noteWork), when it started or opened something the user
 * can look at: a Workshop session and its writer, an AI Editor job, a share link, an automation. Same thing = same
 * id, so following it updates its card. only = update a card that's there, add none.
 */
export function workFor(name: string, a: Args, r: Args): { card: AssistantWork; only?: boolean } | null {
  const session = (id: unknown, title: string, status: AssistantWork["status"], detail?: string): AssistantWork => ({
    id: `workshop:${id}`, kind: "workshop", title, href: `/workshop/sessions/${id}`, status, ...(detail ? { detail } : {}),
  });
  switch (name) {
    case "workshop_new_session":
      return r.id ? { card: session(r.id, String(r.title ?? "Workshop session"), "done", "Session started") } : null;
    case "workshop_chat":
    case "workshop_wait": {
      const reply = (r.reply ?? {}) as Args;
      const status = reply.status === "thinking" ? "running" : reply.status === "error" ? "failed" : "done";
      const detail = status === "running" ? WRITING : status === "failed" ? String(reply.error ?? "The writer stopped") : "The writer is done";
      return { card: session(a.session, String((r.piece as Args | undefined)?.title ?? "Workshop session"), status, detail) };
    }
    case "workshop_session": {
      const chat = (r.chat as Args[] | undefined) ?? [];
      if (!chat.length) return null;
      const writing = chat.some((m) => m.status === "thinking");
      return { card: session(a.session, String(r.title ?? "Workshop session"), writing ? "running" : "done", writing ? WRITING : "The writer is done"), only: true };
    }
    case "editor_run": {
      // this editor's run answers "queued" only: the card opens the edit, where the job shows
      const edit = encodeURIComponent(String(a.edit));
      const toReview = a.kind === "send_to_review";
      return {
        card: {
          id: `edit:${a.edit}:${toReview ? `review:${a.draft}` : a.kind}`, kind: "edit", title: toReview ? `${a.draft} to Review` : kindTitle(a.kind), href: `/editor/${edit}`,
          status: "running", detail: toReview ? "Going into Review" : "The AI Editor is working on it",
        },
      };
    }
    case "use_file": {
      const kind = a.to === "review" ? "review" : a.to === "captions" ? "captions" : "notes";
      const where = { notes: "Video Notes", review: "Review", captions: "Caption Studio" }[kind];
      return r.href
        ? { card: { id: r.id ? `${kind}:${r.id}` : `file:${a.file}:${kind}`, kind, title: String(r.name ?? where), href: String(r.href), status: kind === "notes" ? "running" : "done", detail: String(r.note ?? (kind === "notes" ? "Transcribing and summing it up" : `In ${where}`)) } }
        : null;
    }
    case "notes_get":
      return r.id
        ? { card: { id: `notes:${r.id}`, kind: "notes", title: String(r.name ?? "Video Note"), href: `/video-notes/${r.id}`, status: r.status === "error" ? "failed" : r.status === "ready" ? "done" : "running", detail: String(r.error ?? (r.status === "ready" ? "Ready" : (r.step ?? "Processing"))) }, only: true }
        : null;
    case "review_share":
      return typeof r.share_link === "string" ? { card: { id: `link:${r.share_link}`, kind: "link", title: String(r.name ?? "Share link"), href: r.share_link, status: "done", detail: "Share link: anyone with it can watch" } } : null;
    case "automations_create":
    case "automations_run":
      return r.id
        ? {
            card: {
              id: `automation:${r.id}`, kind: "automation", title: String(r.name ?? "Automation"), href: "/settings/automations",
              ...(name === "automations_run" ? { status: "running" as const, detail: "Running now: the result lands in your inbox" } : { status: "done" as const, detail: "Scheduled" }),
            },
          }
        : null;
    default:
      return null;
  }
}

async function callTool(call: Call, auth: Headers, origin: string, user: SessionUser, name: string, args: Args, plugged: PluginTools) {
  const plug = plugged.handlers.get(name);
  const handler = plug ? (a: Args) => plug(a, { user, origin, api: apiOf(call, auth) }) : tools(call, auth, origin, user)[name];
  const turn = jobTurn(auth.get("authorization") ?? undefined);
  if (turn) noteStep(user.username, turn, stepFor(name, args ?? {}));
  try {
    if (!handler) throw new ToolError(`Unknown tool ${name}.`);
    if (ASSISTANT_TOOLS.has(name) && !isJob(auth)) throw new ToolError(`${name} is for the assistant only.`);
    const result = await handler(args ?? {});
    const work = turn && result && typeof result === "object" && !Array.isArray(result) ? workFor(name, args ?? {}, result as Args) : null;
    if (turn && work) noteWork(user.username, turn, work.card, work.only);
    return { content: Array.isArray(result) ? (result as Content[]) : [{ type: "text", text: JSON.stringify(result, null, 1) }] };
  } catch (e) {
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** One JSON-RPC message in, its answer out (null for a notification). `origin` starts the links the tools hand back. */
export async function handle(call: Call, auth: Headers, msg: Args, origin: string, user: SessionUser, plugged: PluginTools = pluginToolsOf([])): Promise<Args | null> {
  if (msg.id === undefined) return null;
  const params = (msg.params ?? {}) as Args;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "creator-toolset", version: "1.0.0" },
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return ok({});
    case "tools/list": {
      const listed = isJob(auth) ? [...TOOLS, ...ASSISTANT_DEFS] : TOOLS;
      return ok({ tools: [...listed.filter((t) => !plugged.replaced.has(t.name)), ...plugged.defs] });
    }
    case "tools/call":
      return ok(await callTool(call, auth, origin, user, String(params.name), (params.arguments ?? {}) as Args, plugged));
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
  }
}

/** The MCP route. `plugins` (the server's plug-ins, boot.ts) add their tools to the list and the calls; checked here, once. */
export function mcpApp(call: Call, plugins: ServerPlugin[] = []) {
  const app = new Hono<{ Variables: AuthVars }>();
  const plugged = pluginToolsOf(plugins);
  app.post("/", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Args | Args[] | null;
    if (!body) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    const auth = c.req.raw.headers;
    // the account this call runs as (boot.ts): its tools' own calls run as the same account (innerCall)
    const user = c.get("user");
    const inner: Call = (path, init) => innerCall.run(user, () => call(path, init));
    // this server's public address: PUBLIC_ORIGIN, else the address the request came in on (as connectors.ts)
    const url = new URL(c.req.url);
    const origin = process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") || `${c.req.header("x-forwarded-proto") ?? url.protocol.replace(":", "")}://${url.host}`;
    if (Array.isArray(body)) {
      const out = (await Promise.all(body.map((m) => handle(inner, auth, m, origin, user, plugged)))).filter(Boolean);
      return out.length ? c.json(out) : c.body(null, 202);
    }
    const out = await handle(inner, auth, body, origin, user, plugged);
    return out ? c.json(out) : c.body(null, 202);
  });
  // no server-sent stream: everything is answered in the POST
  app.get("/", (c) => c.body(null, 405, { Allow: "POST" }));
  return app;
}
