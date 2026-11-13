import { MODULES } from "./mcp-tools";
import { ToolError, type ToolContext, type ToolDef, type ToolHandler, type WorkCard } from "./mcp-tools/types";
import { reviewOf } from "./mcp-tools/review";
import { Hono } from "hono";
import { MY_KEYS } from "../contracts/service-keys";
import { TOOLS as APP_TOOLS, TOOL_NAMES, readiness, type SetupView } from "../contracts/tools";
import { CHECK, EDITORS, JOBS, MAKES, TALK } from "../contracts/work-prefs";
import { EDIT_STEPS } from "../contracts/editor";
import { routeFor } from "./lib/providers";
import { deviceName } from "./lib/devices";
import { dockSkills } from "./lib/skills";
import { readConnectors } from "./lib/connectors/store";
import { myKeys } from "./my-keys";
import { askConfirm, askFolder, askSend, askSecret, navigateTo, noteChoices, noteMedia, noteStep, noteWork, setConfirmRunner, setInstallGuide, unattended } from "./assistant";
import { FILE_USES, type AssistantFileUse, type AssistantMedia, type AssistantWork } from "../contracts/assistant";
import { mimeOf, uploadLink } from "./assistant-files";
import { SESSION_STATUSES } from "./lib/workshop/types";
import { postedFromUrl } from "./lib/workshop/posted";
import { innerCall, jobTurn, type AuthVars } from "./auth";
import type { SessionUser } from "./users";
import { pluginReplaces, type ServerPlugin } from "./lib/plugin";
import { editorTools, hasStyle } from "./mcp-tools/editor";
import { finalsTools } from "./mcp-tools/finals";
import { mainSource } from "./library/sources";
import type { AssetCard } from "../contracts/library";
import { rollCount, rollLine } from "./library/roll";
import { cardFor, cardResource, cardResourceList, cardToolMeta, hasCard, mediaLinks } from "./mcp-cards";

/**
 * Creator Toolset as a remote MCP server: POST /api/mcp, MCP's Streamable HTTP answered as plain JSON, no sessions. Only a Full AI key gets here
 * (boot.ts: the key is the account itself), sent as `Authorization: Bearer ctk_…` (claude.ai: the connector's
 * Request headers), or one an AI app got by signing in (oauth.ts: ChatGPT, Claude's directory connectors). Every tool calls the site's own routes with the caller's credentials, so each route's checks
 * stay the only checks. The assistant's job token (ctj_…, auth.ts) also gets here: it sees the same tools plus
 * ASSISTANT_DEFS, and only it may call those (isJob checks the header). A Full key sees TOOLS and use_file. The check is on
 * the header, not the account: a signed-in session that sends a ctj_ header can call them as its own account. That
 * is no wider than the account's own reach, since the tools only act for the account they run as.
 */

type Call = (path: string, init: RequestInit) => Promise<Response>;
type Args = Record<string, unknown>;
type Content = { type: "text"; text: string } | { type: "image"; mimeType: string; data: string };


/** The setup answers and, per tool (the picked ones, else all), what it still needs and what would add to it. */
function setupView(v: SetupView) {
  const tools = (v.tools ?? [...APP_TOOLS]).map((t) => {
    const r = readiness(t, v.have);
    return { id: t, name: TOOL_NAMES[t], ready: r.ready, missing: r.missing.map((n) => n.what), extra: r.extra.map((n) => n.what) };
  });
  return { picked: v.tools, plan: v.plan ?? v.detected, setupDone: v.done, tools };
}

/** The tools only the assistant's job token may call (the dock, assistant.ts). */
const ASSISTANT_TOOLS = new Set(["setup_status", "save_setup", "ask_secret", "navigate", "show_video", "notes_get", "offer_choices", "ask_folder"]);
/** Assistant tools a Full key gets too: use_file takes a file its own AI sent with upload_file. */
const KEY_TOO = new Set(["use_file"]);
const isJob = (auth: Headers) => /^Bearer ctj_/.test(auth.get("authorization") ?? "");

/** The most of a recording's words a tool hands the AI at once (about 15 minutes of speech). */
const TRANSCRIPT_MAX = 12_000;

/** MCP clients give up on a tool call after about a minute: a reply still thinking hands back its id to wait on. */
const WAIT_MAX_S = 55;
/** Seconds a media tool waits for new clips to be sorted: after adding them, and when asked with versions. */
export const SORT_WAIT_S = { added: 10, asked: 50 };
/** A media tool answers within this many seconds of its call, under the client's minute. */
const ANSWER_BY_S = 50;
/** What a media tool's answer says while clips are still being sorted (a transcript first). */
const STILL_SORTING = "Some clips are still being sorted (their transcript comes first): media_search with these versions waits for the final count.";

/** Said only where the built-in Finals tools are listed (not where a plug-in's Media Library replaces the app's). */
const FINALS_GUIDE = `Finals: the finished pieces the user keeps. A piece holds versions, and one can be the winner. finals_pieces lists them
(and gives one in full: each version's post description and where it was posted), finals_piece_update renames a piece,
sets the winner, orders its versions and writes a version's name or post description, finals_piece_trash moves one to
the trash or back. A version's id is the one finals_pieces gives.`;

const INSTRUCTIONS = `Creator Toolset, as the signed-in user's account.

Content Workshop: the same projects, sessions, pieces and chat the user sees on the site and the iPhone app, so whatever
you do here shows there at once. A project is one brand (audience, voice, CTA). A session is one idea: its sources,
notes, pieces and chat, with a status (draft, writing, production, editing, toPost = ready to post, published,
shelved). A piece is one reel, carousel, ad, free, youtube script, newsletter, X thread or article: blocks (lines or slides, each with an id), hook
variations, a caption (post description) and a pinned comment. Two ways to write: workshop_chat asks the Workshop's
own writer, which reads the project, the user's posts and past rewrites (it runs on a paired Mac and can take minutes), or
change the text yourself with workshop_edit_piece. Locked blocks are ones the user approved: leave them as they are.

Designer: the user's designs, each a canvas of frames (carousel slides, covers, thumbnails) made of layers they then
edit by hand. You do the designing: design_get lists the designs and reads one (every frame with its layers, a picture
of it, and how a design is written and changed), design_make starts one, design_update changes whole frames or
single layers and shows you the result. Look at what you made and fix it before you say it is done.

Review: his videos waiting for feedback, their versions and timed comments (with the frame each points at).
Resolve a comment only once the change it asks for is made. review_set_approval marks a video approved or sent back.

Instagram (the Analyzer): instagram_refresh starts a pull of one of the user's accounts (on their own Apify key or
official login), instagram_posts lists its posts since a date and the state of its pulls. instagram_search finds the
posts the user saved by words, instagram_post reads one (what is said in it, the text on screen, the idea) and
instagram_save saves a post by its link.

Media Library: the user's footage, their raw material. media_import_folder brings a folder on this computer in (and
reads the script files there), media_search finds files by what they show or say, media_folders lists the folders.
media_search looks in the library and in every source a plug-in adds to it: a hit then names its source, and the answer
says when a filter could not be applied to one. media_get reads one clip in full (its description, what is said in it),
media_update changes its title, tags or description, media_add_to_folder files clips in a folder, media_share makes a
link for other people. Each video sorts itself as A-roll (someone talks to the camera: the takes an edit is built on) or
B-roll (the rest); nobody sets that by hand. After adding files, tell the user the answer's said line.

AI Editor: edits made from footage in the Media Library; each runs steps (analyze, script, draft) into drafts,
one per version, and the run files each draft's preview in Review by itself. editor_create makes a new one from the takes' version ids and starts it:
"edit what I put in this folder today" = media_import_folder (since today), then editor_create with its version ids and
the script file's text. Asked to edit a folder, first say which video it looks like (its script file, a Workshop session
that fits its name) and ask once, in one short question, whether that's right and whether to use the usual setup.

Instagram comments: instagram_comments reads what people write under an account's posts (the user's, or another
creator's added with instagram_add_account), to find the questions they ask most.

Scheduled tasks: schedule_task runs a prompt on its own (every Monday at 9, say), with all these tools.

How the user wants to work (get_work_prefs / set_work_prefs): where they talk to the AI (the app, their own AI chat, or
both) and where they check the work (the app, their own editor, or both).

Changing the app itself: Creator Toolset is open source and takes plug-ins. When the user wants the app to work
differently for them (a page or tool it lacks, a step done another way, a new tool for you), first see whether the
tools here already do the job. If not, build a plug-in instead of changing the app's own files (the source is at
https://creatortoolset.com/api/landing/github; PLUGINS.md there is the guide). With the Creator Toolset Mac app a
plug-in is a folder in the app's plug-ins folder that the user switches on in the app themselves; a server they
host is built with its plug-ins.`;

const str = { type: "string" };
const schedule = {
  type: "object",
  properties: { kind: { type: "string", enum: ["fixed", "once", "interval"] }, at: str, weekdays: { type: "array", items: { type: "integer" } }, runAt: str, everyMinutes: { type: "integer" } },
  required: ["kind"],
};
const lines = { type: "array", items: { type: "object", properties: { id: str, text: str }, required: ["text"] } };
export const TOOLS = [
  { name: "workshop_projects", description: "The Workshop's projects (brands): id, name, audience, voice, CTA, notes. current is the id of the one the app is in.", inputSchema: { type: "object", properties: {} } },
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
    description: "Change a session's title, notes or status (moves it through the stages), or its posts: post_url links an Instagram post (the session becomes published), unlink_post_url unlinks that one, remove_post: true unlinks them all.",
    inputSchema: {
      type: "object",
      properties: {
        session: str, title: str, notes: str, status: { type: "string", enum: [...SESSION_STATUSES] },
        post_url: str, unlink_post_url: str, remove_post: { type: "boolean" },
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
        my_words_only: { type: "boolean", description: "it only picks, trims and orders the user's own sentences in message" },
        deep_research: { type: "boolean", description: "web research first (takes minutes): ask the user before" },
        wait_s: { type: "integer", description: `default and max ${WAIT_MAX_S}` },
      },
      required: ["session", "piece", "message"],
    },
  },
  { name: "workshop_wait", description: "Keep waiting for a workshop_chat reply.", inputSchema: { type: "object", properties: { session: str, reply: str, wait_s: { type: "integer" } }, required: ["session", "reply"] } },
  {
    name: "finals_link_session",
    description: "Link a Finals piece (its id, from finals_pieces) to the Workshop session, and optionally one of its pieces (workshop_piece), so Finals shows a post description per version there.",
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
    description: "An Analyzer account's posts (by handle) taken on or after since (a date, like 2026-10-01): shortcode, url, kind, when, caption, plays, likes, comments, id (once the post is saved in the library: instagram_post reads it), and the state of its pulls.",
    inputSchema: { type: "object", properties: { account: str, since: str }, required: ["account"] },
  },
  { name: "editor_list", description: "AI Editor edits, newest first: id, name, the last step and its state.", inputSchema: { type: "object", properties: {} } },
  { name: "editor_get", description: "One AI Editor edit: its brief, drafts, notes and jobs.", inputSchema: { type: "object", properties: { edit: str }, required: ["edit"] } },
  {
    name: "editor_run",
    description: "Run an AI Editor edit from a step on (analyze, script, draft); the run ends with each draft's preview filed in Review. send_to_review renders one draft's preview again and files it as the next version of its Review video (needs draft): only after the draft changed, never to show one that is already there.",
    // a whole edit cannot run from broll (it belongs to one draft): the page never offers it either
    inputSchema: { type: "object", properties: { edit: str, kind: { type: "string", enum: [...EDIT_STEPS.filter((s) => s !== "broll"), "send_to_review"] }, draft: str }, required: ["edit", "kind"] },
  },
  {
    name: "editor_create",
    description:
      "Make a new AI Editor edit and start it (analyze → script → draft → B-roll → a preview of each version, filed in Review). sources = the talking takes, as version_id from media_search or media_import_folder (up to 50). script = what is said, when the user has one (a script file's text from media_import_folder); brief = what the edit is for and how it should feel. broll_folder = a Media Library folder id (media_folders) to cut B-roll from. versions = how many different versions (1-5), target_s = length in seconds (0 = as long as it needs). start=false only makes it. Takes still being transcribed are waited for. Returns the edit's id and link: editor_get follows it.",
    inputSchema: {
      type: "object",
      properties: { sources: { type: "array", items: str }, name: str, brief: str, script: str, versions: { type: "integer" }, target_s: { type: "integer" }, broll_folder: str, start: { type: "boolean" } },
      required: ["sources"],
    },
  },
  {
    name: "media_import_folder",
    description:
      "Bring a folder on this computer into the Media Library now (read in place, nothing copied): its videos, photos and sound changed on or after since (an ISO date-time with the user's offset, like 2026-11-10T00:00:00+02:00 for today; leave out for all). Returns each file's version_id (for editor_create), said (the line to tell the user: clips added, A-roll and B-roll) and the text of the script files at the top of that folder (.txt, .md, .docx, .rtf, .pages). Never a whole disk or home folder: the folder the files are in. folder = a Media Library folder id to file them in. Only where the app runs on the user's own computer.",
    inputSchema: { type: "object", properties: { path: str, since: str, folder: str }, required: ["path"] },
  },
  {
    name: "media_search",
    description:
      "Search the user's Media Library: q matches titles, tags, AI descriptions and what is said in the clips (best match first; said = where it is said); leave it out for the newest. kind = video, image, audio or doc; roll = a (A-roll) or b (B-roll); folder = a folder id (media_folders); since = only files added on or after this date; versions = version ids just added: said then counts how they were sorted, waiting up to 50 s for it. Each hit: id, version_id (for editor_create), title, kind, roll, state (ready once processed), length, description, tags.",
    inputSchema: { type: "object", properties: { q: str, kind: { type: "string", enum: ["video", "image", "audio", "doc"] }, roll: { type: "string", enum: ["a", "b"] }, folder: str, since: str, versions: { type: "array", items: str }, limit: { type: "integer" } } },
  },
  { name: "media_folders", description: "The Media Library's folders: id, name, how many files. A folder id goes into media_search and editor_create's broll_folder; media_import_folder files into a plain folder (kind manual), not a smart one.", inputSchema: { type: "object", properties: {} } },
  {
    name: "instagram_add_account",
    description: "Add an Instagram account to the Analyzer by handle and start pulling its posts: the user's own (mine=true) or any other creator's public account (on the user's Apify key). Its posts take a few minutes to come in: instagram_posts shows them (and the pull's state) once they have.",
    inputSchema: { type: "object", properties: { handle: str, mine: { type: "boolean" } }, required: ["handle"] },
  },
  {
    name: "instagram_comments",
    description:
      "The comments on an Analyzer account's posts (the user's or another creator's), to find what people ask and push back on: the posts taken on or after since (newest first, up to posts, default 10), or the posts given by shortcode. Comments not pulled yet are pulled now (on the user's Apify key; about a minute) and waited for; a post still pulling is listed under pending: call again for it. Each comment: post, text, likes, replies, and kind (question, pushback, praise…) when it has been read. Up to max comments (default 100, most liked first), spam and one-word replies left out.",
    inputSchema: { type: "object", properties: { account: str, since: str, posts: { type: "integer" }, shortcodes: { type: "array", items: str }, max: { type: "integer" } }, required: ["account"] },
  },
  // scheduled tasks (automations.ts): a prompt the user's AI runs on its own, each run a turn in an assistant chat
  {
    name: "schedule_task",
    description:
      "Create a scheduled task, or change one (id: only the fields given change; enabled=false pauses it). Each run sends prompt to the user's AI with these tools and posts it and the answer in an assistant chat. schedule: {kind:'fixed',at:'HH:MM',weekdays?:[0-6, 0=Sunday; leave out for every day]} (needs timezone: the user's IANA zone, which their message gives), {kind:'once',runAt:'ISO date-time with offset'} or {kind:'interval',everyMinutes}. destination: continue (default from a chat: runs post in this chat), fresh (this chat, each run without earlier runs' context), new_chat (a new chat each run). It runs on the AI answering now; the user changes that in Settings, Scheduled tasks. project = a Workshop project id. Tell the user the returned next_run.",
    inputSchema: {
      type: "object",
      properties: { id: str, name: str, prompt: str, schedule, timezone: str, destination: { type: "string", enum: ["continue", "fresh", "new_chat"] }, project: { type: ["string", "null"] }, enabled: { type: "boolean" } },
    },
  },
  { name: "list_scheduled_tasks", description: "The user's scheduled tasks: id, name, prompt, schedule, destination, enabled, next_run and the last result (done, error or skipped, with its text). Use an id with schedule_task, run_scheduled_task_now or delete_scheduled_task.", inputSchema: { type: "object", properties: {} } },
  { name: "run_scheduled_task_now", description: "Run a scheduled task (id) now, as its schedule would. It runs in the background: its answer lands in its chat.", inputSchema: { type: "object", properties: { id: str }, required: ["id"] } },
  { name: "delete_scheduled_task", description: "Delete a scheduled task (id) for good. To pause it instead, schedule_task with enabled=false.", inputSchema: { type: "object", properties: { id: str }, required: ["id"] } },
  { name: "get_work_prefs", description: "How the user wants to work: talk (app | chat | both), check (app | editor | both), their editor and what they make.", inputSchema: { type: "object", properties: {} } },
  {
    name: "set_work_prefs",
    description: "Change how the user wants to work. talk = where they talk to the AI (app, chat = their own AI chat, both); check = where they check the work (app, editor, both); editor = which video editor (or null); makes = what they make; job = what they want to do first (or null).",
    inputSchema: { type: "object", properties: { talk: { type: "string", enum: [...TALK] }, check: { type: "string", enum: [...CHECK] }, editor: { type: ["string", "null"], enum: [...EDITORS, null] }, makes: { type: "array", items: { type: "string", enum: [...MAKES] } }, job: { type: ["string", "null"], enum: [...JOBS, null] } } },
  },
  {
    name: "upload_file",
    description: "Send a video or recording on your computer to this server when it runs elsewhere: path = the file there, size = its bytes. Run the answer's command, then use_file with its file id.",
    inputSchema: { type: "object", properties: { path: str, size: { type: "integer" } }, required: ["path", "size"] },
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
  {
    name: "offer_choices",
    description: "Put 2 to 4 short answers under your reply as buttons, for a question the user answers in one tap (\"Start with my usual setup\" / \"Change the setup\"). A press sends that answer as their next message. Ask the question in your reply too.",
    inputSchema: { type: "object", properties: { choices: { type: "array", items: str } }, required: ["choices"] },
  },
  {
    name: "ask_folder",
    description: "Ask the user to choose a folder on their computer (a shoot to edit, footage to bring in): a Choose a folder button under your reply. why = what the folder is for, in a few words. Their choice comes with their next message. Ask for it in your reply too.",
    inputSchema: { type: "object", properties: { why: str }, required: ["why"] },
  },
  { name: "navigate", description: "Open a page of the app for the user: a relative path such as /workshop or /settings/connectors.", inputSchema: { type: "object", properties: { path: str }, required: ["path"] } },
  {
    name: "show_video",
    description: "Play a video inside the chat, with a link to its page: a Review video (link: its link or id, as get_review takes; version: its number, default the newest ready one), or an AI Editor draft's preview (edit and draft, as editor_get lists them).",
    inputSchema: { type: "object", properties: { link: str, version: { type: "integer" }, edit: str, draft: str } },
  },
  {
    name: "use_file",
    description: "Send a video or recording to a tool: file = the id of one dropped in the chat, or path = a file on this computer (when the server runs on it; not for library: media_import_folder reads its folder in place). to: notes = Video Notes (transcript, summary, chapters; follow it with notes_get, which also writes takeaways, an action plan and quotes), review = a Review video (then review_share for a link; with version_of = a Review video's link or id, as get_review takes, the file becomes that video's next version instead), captions = a Caption Studio project whose captions are made at once (the chat says when they are ready; captions_get reads them), library = the Media Library, where each clip sorts itself as A-roll or B-roll (files = several dropped ids at once; tell the user the answer's said line). name = a title for it (default the file's name). The same file can go to several.",
    inputSchema: { type: "object", properties: { file: str, files: { type: "array", items: str }, path: str, to: { type: "string", enum: [...FILE_USES] }, name: str, version_of: str }, required: ["to"] },
  },
  {
    name: "notes_get",
    description: "A Video Note (use_file to: notes gives its id; notes_list finds one): status (processing with its step, ready, error), title, summary and chapters once ready, and the takeaways, action plan and quotes it has. add = the ones to write when it has none yet (the user's AI writes them; when the answer says still_writing, call again). transcript: true adds what is said in it. Waits up to 50 s (wait_s: less).",
    inputSchema: { type: "object", properties: { id: str, transcript: { type: "boolean" }, add: { type: "array", items: { type: "string", enum: ["takeaways", "action plan", "quotes", "summary", "chapters"] } }, wait_s: { type: "integer" } }, required: ["id"] },
  },
];

/** A plug-in's MCP tool: its listing (the shape of TOOLS) and the handler that answers it. The same shapes as a built-in module's (mcp-tools/types.ts). */
export type PluginToolDef = ToolDef;
/** What a tool handler gets besides its arguments: the account it runs as, this server's address, the site's routes as that account, and sure(). */
export type PluginToolContext = ToolContext;
export type PluginToolHandler = ToolHandler;
export type PluginTools = {
  defs: PluginToolDef[];
  handlers: Map<string, PluginToolHandler>;
  replaced: Set<string>;
  /** What a plug-in tool's call looks like to the person watching, by tool name. */
  steps: Record<string, string>;
  /** Each plug-in's cards: asked in turn for a call of one of its tools. */
  work: Array<(name: string, args: Args, result: Args) => WorkCard | null>;
  /** What the plug-ins add to the assistant's guide and to the MCP server's instructions: how this install differs. */
  guide: string;
};

/** The tools kept in their own files (mcp-tools/index.ts), by name. */
const MODULE_DEFS: ToolDef[] = MODULES.flatMap((m) => m.defs);
const MODULE_HANDLERS = new Map<string, ToolHandler>(MODULES.flatMap((m) => Object.entries(m.handlers)));
const MODULE_STEPS: Record<string, string> = Object.assign({}, ...MODULES.map((m) => m.steps ?? {}));
const DOCK_ONLY = new Set(MODULE_DEFS.filter((d) => d.dockOnly).map((d) => d.name));
/**
 * The built-in AI Editor's own tools (mcp-tools/editor.ts). On an install where a plug-in answers /api/editor they
 * would act on that plug-in's routes by accident (its stop is a 404, its delete is not a trash), so they are left out
 * there unless the plug-in serves a tool of the same name.
 */
const BUILT_IN_EDITOR = new Set(editorTools.defs.map((d) => d.name));
/**
 * The built-in Finals tools (mcp-tools/finals.ts) work on the pieces of the app's own library. On an install whose
 * Media Library is a plug-in's (LibrarySource.main) the person never sees that library, so the tools would list and
 * change pieces that are on no page there: left out, like the editor's.
 */
const BUILT_IN_FINALS = new Set(finalsTools.defs.map((d) => d.name));
const notHere = (name: string) => (BUILT_IN_EDITOR.has(name) && pluginReplaces("/api/editor")) || (BUILT_IN_FINALS.has(name) && !!mainSource());

/**
 * The plug-ins' MCP tools (a plugin's `tools: { defs, handlers, replaces }`), gathered once when the server boots. A tool whose name a
 * built-in or assistant tool already has throws, unless the same plug-in lists that built-in in `replaces`: its tool then answers the
 * name, and the built-in is left out of the list. `replaces` takes only TOOLS names, each by one plug-in, and the plug-in must serve a
 * tool of that name. A def with no handler throws. The boot refuses rather than shadowing a tool by accident.
 * `steps`, `work` and `guide` are optional: the line a call shows, the card it leaves, and what the assistant should know about this install.
 */
export function pluginToolsOf(plugins: ServerPlugin[]): PluginTools {
  const builtIn = new Set([...TOOLS.map((t) => t.name), ...MODULE_DEFS.filter((d) => !d.dockOnly).map((d) => d.name)]);
  const taken = new Set<string>([...builtIn, ...ASSISTANT_DEFS.map((t) => t.name), ...DOCK_ONLY]);
  const out: PluginTools = { defs: [], handlers: new Map(), replaced: new Set(), steps: {}, work: [], guide: "" };
  for (const plugin of plugins) {
    const { defs = [], handlers = {}, replaces = [], steps = {}, work, guide } = (plugin.tools ?? {}) as {
      defs?: PluginToolDef[];
      handlers?: Record<string, PluginToolHandler>;
      replaces?: string[];
      steps?: Record<string, string>;
      work?: (name: string, args: Args, result: Args) => WorkCard | null;
      guide?: string;
    };
    Object.assign(out.steps, steps);
    if (work) out.work.push(work);
    if (guide?.trim()) out.guide += `${out.guide ? "\n\n" : ""}${guide.trim()}`;
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
/** A date the AI gives (ISO, with or without a time) → epoch ms. */
const dateMs = (v: unknown) => {
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  if (Number.isNaN(ms)) throw new ToolError(`${String(v)} is not a date: give one like 2026-11-10T00:00:00+02:00.`);
  return ms;
};

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

/** A scheduled task as the AI reads it: the next run as an ISO time it can say, the last result's line. */
const taskOut = (t: Args) => ({
  id: t.id,
  name: t.name,
  prompt: t.prompt,
  schedule: t.schedule,
  timezone: t.timezone,
  destination: t.destination,
  enabled: t.enabled,
  running: t.running,
  next_run: typeof t.nextRun === "number" ? new Date(t.nextRun).toISOString() : null,
  last_result: t.lastResult ?? null,
});

/** The tools, each a thin client of the site's own routes with the caller's credentials. */
function tools(call: Call, auth: Headers, origin: string, user: SessionUser, sure: ToolContext["sure"]) {
  const api = apiOf(call, auth);
  /** A tool that opens something on the person's screen has nobody to open it for in a scheduled run. */
  const someoneThere = () => {
    const turn = jobTurn(auth.get("authorization") ?? undefined);
    if (turn && unattended(user.username, turn)) throw new ToolError("Nobody is at the screen in a scheduled run: say it in your answer instead.");
  };
  const json = async <T = Args>(path: string, method = "GET", body?: unknown) => (await (await api(path, method, body)).json()) as T;
  const ws = <T = Args>(path: string, method = "GET", body?: unknown) => json<T>(`/api/workshop${path}`, method, body);
  /** An Analyzer account of the user's by handle → its id (the account routes take the id). */
  const accountOf = async (handle: string) => {
    const name = handle.replace(/^@/, "").toLowerCase();
    const found = (await json<Args[]>(`/api/instagram/accounts?q=${encodeURIComponent(name)}`)).find((a) => String(a.username ?? "").toLowerCase() === name);
    if (!found) throw new ToolError(`No account of yours is called @${name}: instagram_add_account adds it.`);
    return String(found.id);
  };
  /** The account's own Media Library (the first one), which the media tools read and write. */
  const homeLibraryId = async () => {
    const lib = (await json<{ libraries: Args[] }>("/api/library")).libraries[0];
    if (!lib) throw new ToolError("This account has no Media Library yet.");
    return String(lib.id);
  };
  /** What a plug-in adds to that library, as this account may see it (its /library page lists these beside "Library"). None unless a plug-in brings one. */
  const librarySources = async (lib: string) =>
    (await json<{ sources?: Array<{ id: string; label: string; main?: boolean }> }>(`/api/library/${encodeURIComponent(lib)}/sources`).catch(() => null))?.sources ?? [];
  /**
   * One plug-in source's cards for a search (its own list takes q and nothing else), or null when it fails or is not
   * back by `by`. `refused`: the source's own reason for listing nothing (SourceRefusal).
   */
  const sourceCards = async (lib: string, source: string, q: unknown, by: number): Promise<{ items: Args[]; refused?: string } | null> => {
    const ask = new URLSearchParams({ source, ...(q ? { q: String(q) } : {}) });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>((done) => (timer = setTimeout(() => done(null), Math.max(0, by - Date.now()))));
    const cards = json<{ items?: Args[]; refused?: string }>(`/api/library/${encodeURIComponent(lib)}/assets?${ask}`).then(
      (r) => ({ items: r.items ?? [], ...(r.refused ? { refused: r.refused } : {}) }),
      () => null,
    );
    return Promise.race([cards, late]).finally(() => clearTimeout(timer));
  };
  /** The said line for versions just added (roll.ts), waiting up to waitS (never past `by`) while some are still being sorted. */
  const sortedLine = async (lib: string, versions: string[], waitS: number, by = Date.now() + ANSWER_BY_S * 1000) => {
    const end = Math.min(by, Date.now() + waitS * 1000);
    const q = new URLSearchParams({ versions: versions.slice(0, 200).join(","), limit: "200" });
    for (;;) {
      const items = (await json<{ items?: AssetCard[] }>(`/api/library/${encodeURIComponent(lib)}/assets?${q}`)).items ?? [];
      const { left } = rollCount(items);
      if (!left || Date.now() >= end) return { said: rollLine(items), left };
      await sleep(Math.min(3000, end - Date.now()));
    }
  };
  /** use_file to the library: each dropped file is added (a copy the library keeps), then one line says how they were sorted. */
  const toLibrary = async (a: Args) => {
    const by = Date.now() + ANSWER_BY_S * 1000;
    // a file on this computer is read where it is, never copied: its folder goes in with media_import_folder
    if (a.path) throw new ToolError("For a file on this computer, use media_import_folder with its folder (and since): it is read where it is.");
    const ids = [...(Array.isArray(a.files) ? a.files.map(String) : []), ...(a.file ? [String(a.file)] : [])];
    if (!ids.length) throw new ToolError("Give the dropped files' ids.");
    const files: Args[] = [];
    for (const id of ids.slice(0, 50)) {
      // big files take a while each: the ones not reached in time are named, to send again
      if (Date.now() > by - 15_000) {
        files.push({ file: id, not_yet: "Not added yet: call use_file again with these" });
        continue;
      }
      try {
        const r = await json(`/api/assistant/files/${encodeURIComponent(id)}/use`, "POST", { to: "library", ...(ids.length === 1 ? pick(a, ["name"]) : {}) });
        files.push({ name: r.name, version_id: r.versionId, library: r.libraryId, href: r.href, ...pick(r, ["note"]) });
      } catch (e) {
        files.push({ file: id, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const added = files.filter((f) => f.version_id);
    const lib = String(added[0]?.library ?? "");
    // nothing went in: the line says why, when every file was refused for the same reason
    const why = new Set(files.map((f) => f.error));
    const none = `Nothing was added${why.size === 1 && files[0]?.error ? `: ${String(files[0].error)}` : ""}`;
    const sorted = lib ? await sortedLine(lib, added.map((f) => String(f.version_id)), SORT_WAIT_S.added, by) : { said: none, left: 0 };
    return {
      said: sorted.said,
      files: files.map(({ library: _, ...f }) => f),
      ...(lib ? { href: added.length === 1 ? added[0]!.href : `/library?library=${lib}` } : {}),
      ...(sorted.left ? { note: STILL_SORTING } : {}),
    };
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
    workshop_projects: async () => {
      const w = await ws<{ currentProjectId: string | null; projects: Args[] }>("/workspace");
      return { current: w.currentProjectId, projects: w.projects.map((p) => pick(p, ["id", "name", "audience", "voice", "cta", "notes"])) };
    },
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
      // notes: "" clears them (pick would drop it)
      const body: Args = { ...pick(a, ["title", "status"]), ...(typeof a.notes === "string" ? { notes: a.notes } : {}) };
      // through the session's own PATCH, so the link is checked as it is from the app
      if (a.remove_post === true) body.posted = null;
      else if (a.unlink_post_url) {
        // only a post that is linked: the route marks whatever it is given "never match again"
        const code = postedFromUrl(String(a.unlink_post_url))?.shortcode;
        const now = code ? await ws(`/sessions/${a.session}`) : null;
        if (!now || !((now.postings as Args[] | undefined) ?? (now.posted ? [now.posted as Args] : [])).some((p) => p.shortcode === code)) throw new ToolError("That post is not linked to this session.");
        body.posted = { remove: code };
      } else if (a.post_url) body.posted = a.post_url;
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give a title, notes, status or a post.");
      return pick(await ws(`/sessions/${a.session}`, "PATCH", body), ["id", "title", "status", "posted", "postings"]);
    },
    workshop_new_piece: async (a) => piece(await ws(`/sessions/${a.session}/docs`, "POST", pick(a, ["kind", "title", "text"]))),
    workshop_edit_piece: async (a) => {
      const body = pick(a, ["title", "blocks", "hooks", "caption", "pinned"]);
      if (!Object.keys(body).length) throw new ToolError("Nothing to change.");
      return piece(await ws(`/sessions/${a.session}/docs/${a.piece}`, "PATCH", body));
    },
    workshop_chat: async (a) => {
      const started = await ws<{ reply: Args }>(`/sessions/${a.session}/chat`, "POST", { docId: a.piece, text: a.message, ...(a.scope ? { scope: a.scope } : {}), ...(a.my_words_only === true ? { mine: true } : {}), ...(a.deep_research === true ? { deep: true } : {}) });
      return wait({ session: a.session, reply: started.reply.id, wait_s: a.wait_s });
    },
    workshop_wait: wait,
    finals_link_session: async (a) =>
      ws(`/sessions/${a.session}/finals`, "POST", { pieceId: a.piece, ...(a.workshop_piece ? { docId: a.workshop_piece } : {}) }),
    list_reviews: async () => {
      const folders = new Map((await json<Args[]>("/api/review/projects")).map((p) => [p.id, p.name]));
      return { reviews: (await json<Args[]>("/api/review")).map((r) => {
        const versions = (r.versions as Args[] | undefined) ?? [];
        return {
          ...pick(r, ["id", "name"]),
          ...(folders.has(r.projectId) ? { folder: folders.get(r.projectId) } : {}),
          approval: (r.approval as Args | undefined)?.status,
          versions: versions.length,
          latest_file: versions.at(-1)?.name,
          latest_comments: r.comments,
          new_comments: r.newComments,
          updated: when(r.updatedAt),
          link: `${origin}/review/${r.id}`,
        };
      }) };
    },
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
        versions: [...versions.values()].map((v) => ({
          ...pick(v, ["n", "name", "duration", "fps", "width", "height", "status", "removed"]),
          // the file itself, where this caller may have it: a link the person presses (the owner's needs their sign-in)
          ...(asset.download && !v.removed && v.status !== "error" ? { download: `${origin}${path}/v/${v.n}/download` } : {}),
        })),
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
      const r = await reviewOf({ json, origin }, a.link);
      const had = r.comments.find((c) => c.id === a.comment_id);
      if (!had) throw new ToolError("No comment with that id on this video: get_review lists them.");
      if (!r.manage && !had.mine) throw new ToolError("That video is someone else's: on its share link you can resolve only the comments you wrote.");
      const cm = await json(`${r.path}/comments/${encodeURIComponent(String(a.comment_id))}`, "PATCH", { resolved: a.resolved !== false });
      return { id: cm.id, resolved: !!cm.resolved, text: cm.text };
    },
    use_file: async (a) => {
      // what the tool still needs comes first: the assistant asks for it (ask_secret) or opens the page that holds it, then tries again
      const tool = a.to === "review" ? "review" : a.to === "captions" ? "captions" : a.to === "library" ? "media" : "notes";
      const { missing } = readiness(tool, (await json<SetupView>("/api/setup")).have);
      if (missing.length) {
        // the page each kind of need is set up on, the same ones Settings → Tools sends a person to
        const page: Record<Exclude<(typeof missing)[number]["form"], "keys">, string> = { ai: "/settings/providers", apify: "/settings/keys", library: "/library", project: "/projects" };
        return {
          not_yet: `${TOOL_NAMES[tool]} needs these first; then call use_file again.`,
          needs: missing.map((n) => ({ what: n.what, ...(n.form === "keys" ? { ask_secret: n.anyOf } : { open: page[n.form] }) })),
        };
      }
      // a file dropped in the Mac app, from the dock, on a server that isn't on that computer: the dock sends that one file
      const turn = jobTurn(auth.get("authorization") ?? undefined);
      const name = a.path && turn && process.env.CT_LOCAL !== "1" ? await askSend(user, turn, `${origin}/api/mcp`, String(a.path), a.to as AssistantFileUse) : null;
      if (name) return { sending: name, note: "It has to be on this server first, and the chat is sending it now: say so in one line and end your reply. The chat carries on with it once it is here." };
      if (a.to === "library") return toLibrary(a);
      if (!a.file && !a.path) throw new ToolError("Give the dropped file's id, or a path on this computer.");
      // a fix for a video already in Review: found by its link or id as the caller; the use route takes only the owner's own
      if (a.version_of && a.to !== "review") throw new ToolError("version_of goes with to: review.");
      const of = a.version_of ? { version_of: ((await json(reviewPath(String(a.version_of), origin))).asset as Args).id } : {};
      const file = a.path ? (await json(`/api/assistant/files/path`, "POST", { path: a.path })).id : a.file;
      return json(`/api/assistant/files/${encodeURIComponent(String(file))}/use`, "POST", { ...pick(a, ["to", "name"]), ...of });
    },
    notes_get: async (a) => {
      const path = `/api/clips/${encodeURIComponent(String(a.id))}`;
      // GET /api/clips/:id also answers a shared note's link: only this account's own here
      const mine = (n: Args) => {
        if (n.owner !== user.username && user.role !== "admin") throw new ToolError("Not found, or not this account's.");
        return n;
      };
      const by = Date.now() + Math.max(0, Math.min(Number(a.wait_s ?? ANSWER_BY_S), ANSWER_BY_S)) * 1000;
      let n = mine(await json(path));
      while (n.status === "processing" && Date.now() < by) n = (await sleep(2000), mine(await json(path)));
      // a note's sections in the page's own words; the routes know them by kind ("action items" is how people ask for the plan)
      const KIND: Record<string, string> = { takeaways: "takeaways", "action plan": "actions", quotes: "quotes", summary: "summary", chapters: "chapters" };
      const wordOf = (kind: unknown) => Object.keys(KIND).find((w) => KIND[w] === kind) ?? String(kind);
      const asked = (Array.isArray(a.add) ? a.add : []).map((w) => {
        const said = String(w).trim().toLowerCase();
        const kind = KIND[said] ?? (said === "action items" || said === "actions" ? "actions" : undefined);
        if (!kind) throw new ToolError(`add takes ${Object.keys(KIND).join(", ")}.`);
        return kind;
      });
      const has = (kind: string) => (kind === "summary" ? !!n.summary : kind === "chapters" ? !!(n.chapters as unknown[] | undefined)?.length : ((n.blocks as Args[] | undefined) ?? []).some((b) => b.kind === kind));
      const writing = () => (n.generating as string[] | undefined) ?? [];
      // the ones asked for that the note has not got: each is written by the person's own AI, and waited for while there is time
      const want = n.status === "ready" && n.hasTranscript ? asked.filter((k) => !has(k)) : [];
      for (const k of want) if (!writing().includes(k)) await api(`${path}/blocks`, "POST", { kind: k });
      if (want.length) n = mine(await json(path));
      while (want.some((k) => writing().includes(k)) && Date.now() < by) n = (await sleep(1000), mine(await json(path)));
      const still = want.filter((k) => writing().includes(k));
      const failed = Object.fromEntries(want.filter((k) => !has(k) && !still.includes(k) && (n.blockErrors as Args | undefined)?.[k]).map((k) => [wordOf(k), (n.blockErrors as Args)[k]]));
      const blocks = Object.fromEntries(((n.blocks as Args[] | undefined) ?? []).map((b) => [wordOf(b.kind), b.text ?? ((b.items as Args[] | undefined) ?? []).map((x) => x.text)]));
      // what is said, as plain text; a long recording is cut and says so
      let said: string | undefined;
      if (a.transcript === true && n.status === "ready" && n.hasTranscript) {
        const words = (await json<{ words?: Array<{ text: string }> }>(`${path}/transcript`)).words ?? [];
        const all = words.map((w) => w.text).join(" ").replace(/\s+/g, " ").trim();
        said = all.length > TRANSCRIPT_MAX ? `${all.slice(0, TRANSCRIPT_MAX)} … (cut: ${all.length.toLocaleString("en-US")} characters in all; the page has the rest)` : all;
      }
      return {
        ...pick(n, ["id", "name", "status", "step", "error"]),
        link: `${origin}/video-notes/${n.id}`,
        ...(n.status === "processing" ? { note: "Still processing: call notes_get again." } : {}),
        ...(n.status === "ready" && !n.hasTranscript ? { note: "No transcript: the file has no speech, or this account's cloud transcription is off (an admin switches it on)." } : {}),
        // a new note keeps its summary beside its blocks, not in them
        ...(n.summary ? { summary: n.summary } : {}),
        ...blocks,
        ...(said ? { transcript: said } : {}),
        ...((n.chapters as Args[] | undefined)?.length ? { chapters: (n.chapters as Args[]).map((c) => `${clock(Number(c.t))} ${c.title}`) } : {}),
        ...(still.length ? { still_writing: still.map(wordOf), note: "Still writing: call notes_get again with the same add." } : {}),
        ...(Object.keys(failed).length ? { could_not_write: failed } : {}),
      };
    },
    review_set_approval: async (a) => {
      const at = await reviewOf({ json, origin }, a.link);
      if (!at.manage && a.status !== "approved" && a.status !== "changes") throw new ToolError("That video is someone else's: on its share link you can approve it or ask for changes (approved, changes), nothing else.");
      const r = await json(`${at.path}/approval`, "POST", { status: a.status });
      return { id: r.id, name: r.name, approval: (r.approval as Args | undefined)?.status };
    },
    review_share: async (a) => {
      const at = await reviewOf({ json, origin }, a.link);
      if (!at.manage) throw new ToolError("That video is someone else's: only its owner can change its share link.");
      if (a.on !== false && !(at.asset.share as { enabled?: boolean } | null)?.enabled) await sure(`Turn on the share link of "${String(at.asset.name).slice(0, 80)}"? Anyone with the link can watch${a.download === true ? ", comment and download the file" : " and comment"}, no account needed.`);
      const share = { enabled: a.on !== false, ...(typeof a.download === "boolean" ? { download: a.download } : {}) };
      const r = await json(at.path, "PATCH", { share });
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
      const acc = await json(`/api/instagram/accounts/${await accountOf(String(a.account))}?lite=1`);
      const rows = ((acc.catalog as Args[] | undefined) ?? []).filter((r) => (r.takenAt as number) >= sinceMs).sort((x, y) => (y.takenAt as number) - (x.takenAt as number));
      // a catalog row carries a short preview only; a saved post's own text is in the same answer
      const saved = new Map(((acc.posts as Args[] | undefined) ?? []).map((p) => [p.id, p.caption]));
      return {
        account: acc.username,
        jobs: acc.jobs,
        posts: rows.map((r) => ({
          ...pick(r, ["shortcode", "url", "kind"]),
          ...(r.postId ? { id: r.postId } : {}),
          when: when(r.takenAt),
          caption: String(saved.get(r.postId) ?? r.captionPreview ?? "").slice(0, 300),
          ...pick((r.counts ?? {}) as Args, ["plays", "likes", "comments"]),
        })),
      };
    },
    editor_list: async () => ({
      edits: (await json<Args[]>("/api/editor")).map((e) => ({ ...pick(e, ["id", "name", "last"]), updated: when(e.updatedAt), link: `${origin}/editor/${e.id}` })),
    }),
    editor_get: async (a) => {
      const e = await json(`/api/editor/${encodeURIComponent(String(a.edit))}`);
      const jobs = (e.jobs as Args[] | undefined) ?? [];
      const previews = (e.previews as Record<string, { assetId: string; n: number }> | undefined) ?? {};
      const titles = (e.plans as Args[] | undefined) ?? [];
      return {
        ...pick(e, ["id", "name", "brief", "script", "versions", "notes"]),
        // each draft with where its preview is: "in Review" plays with show_video (edit + draft) and opens at review
        drafts: ((e.drafts as string[] | undefined) ?? []).map((name) => {
          const own = jobs.filter((j) => j.variant === name);
          const p = previews[name];
          const preview = own.some((j) => j.state === "queued" || j.state === "running") ? "being made" : own.some((j) => j.state === "failed" || j.state === "needs_key") ? "failed" : p ? "in Review" : "none";
          return { name, ...pick(titles.find((x) => x.name === name) ?? {}, ["title"]), preview, ...(p ? { review: `/review/${p.assetId}?v=${p.n}` } : {}) };
        }),
        ...(Object.keys((e.flags as Args | undefined) ?? {}).length ? { flags: e.flags } : {}),
        link: `${origin}/editor/${e.id}`,
        // the newest ten, and every one that failed or needs setup however old
        jobs: jobs.filter((j, i) => i >= jobs.length - 10 || j.state === "failed" || j.state === "needs_key").map((j) => pick(j, ["id", "kind", "variant", "state", "error"])),
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
    editor_create: async (a) => {
      const sources = Array.isArray(a.sources) ? a.sources.map(String) : [];
      if (!sources.length) throw new ToolError("Give sources: the takes' version_id (media_search or media_import_folder).");
      const body: Args = { sources, ...pick(a, ["name", "brief", "script", "versions"]) };
      if (a.target_s != null) body.targetS = a.target_s;
      if (a.broll_folder) body.brollCollectionId = a.broll_folder;
      const { id } = await json<{ id: string }>("/api/editor", "POST", body);
      if (a.start !== false) await json(`/api/editor/${encodeURIComponent(id)}/run`, "POST", { from: "analyze" });
      return { id, name: a.name ?? "Untitled edit", status: a.start !== false ? "started" : "made", link: `${origin}/editor/${id}`, note: "It runs by itself and files each version's preview in Review; the chat says when it is ready, so end your reply rather than wait." };
    },
    media_folders: async () => {
      const lib = await homeLibraryId();
      const others = await librarySources(lib);
      const { collections } = await json<{ collections: Args[] }>(`/api/library/${lib}/collections`);
      return {
        library: lib,
        folders: collections.map((c) => pick(c, ["id", "name", "kind", "parentId", "count"])),
        // a plug-in's source has no folders here
        ...(others.length ? { note: `These are the Library's own folders. media_search also searches, with no folders here: ${others.map((s) => s.label).join(", ")}.` } : {}),
      };
    },
    media_search: async (a) => {
      const by = Date.now() + ANSWER_BY_S * 1000;
      const lib = await homeLibraryId();
      const limit = Math.max(1, Math.min(Number(a.limit ?? 50), 200));
      const q = new URLSearchParams({ limit: String(limit) });
      const versions = Array.isArray(a.versions) ? a.versions.map(String) : [];
      // what a plug-in adds to this library is searched too; a folder and version ids are the library's own
      const others = await librarySources(lib);
      // a source that IS the install's Media Library (its page shows that, not the app's own storage): only it is searched
      const main = versions.length || a.folder ? undefined : others.find((s) => s.main);
      const asked = versions.length || a.folder ? [] : main ? [main] : others;
      const said = versions.length ? (await sortedLine(lib, versions, SORT_WAIT_S.asked)).said : undefined;
      if (versions.length) q.set("versions", versions.join(","));
      if (a.q) q.set("q", String(a.q));
      if (a.kind) q.set("kind", String(a.kind));
      if (a.roll) q.set("roll", String(a.roll));
      if (a.folder) q.set("collectionId", String(a.folder));
      if (a.since) q.set("from", String(dateMs(a.since)));
      // a typed search asks the library's fuller search: words in the title, tags and description, words that are said (with
      // the second they are said at) and, where it is on, clips close in meaning. It answers its best hits, one per matching
      // moment; since and version ids are the list's own, so those still go to the list.
      const moments = new Map<string, Array<{ at: string; text: string }>>();
      let page: { items: Args[] };
      if (main) page = { items: [] };
      else if (a.q && !a.since && !versions.length) {
        const ask = new URLSearchParams({ q: String(a.q) });
        for (const k of ["kind", "roll", "collectionId"]) if (q.get(k)) ask.set(k, q.get(k)!);
        const hits = await json<Array<{ asset: Args; seconds?: number; snippet?: string }>>(`/api/library/${lib}/search?${ask}`);
        const byClip = new Map<string, Args>();
        for (const h of hits) {
          const id = String(h.asset.id);
          if (!byClip.has(id)) byClip.set(id, h.asset);
          if (h.snippet && typeof h.seconds === "number" && (moments.get(id)?.length ?? 0) < 3) moments.set(id, [...(moments.get(id) ?? []), { at: clock(h.seconds).replace(/\.\d+$/, ""), text: h.snippet.replace(/\s+/g, " ").trim().slice(0, 200) }]);
        }
        page = { items: [...byClip.values()].slice(0, limit) };
      } else page = await json<{ items: Args[] }>(`/api/library/${lib}/assets?${q}`);
      // with more than one source, each hit says which it is from
      const hit = (f: Args, source?: string) => ({
        ...pick(f, ["id", "versionId", "title", "kind", "roll", "state", "durationS", "tags"]),
        ...(f.description ? { description: String((f.description as Args).text).slice(0, 300) } : {}),
        ...(f.capturedAt ? { captured: when(f.capturedAt) } : {}),
        ...(moments.has(String(f.id)) ? { said: moments.get(String(f.id)) } : {}),
        ...(source ? { source } : {}),
      });
      const files = page.items.map((f) => hit(f, others.length ? "Library" : undefined));
      const named = (label: string) => (main ? undefined : label);
      // a filter a source could not take is said, never dropped in silence
      const notes: string[] = [];
      if (others.length && !asked.length) notes.push(`A folder and version ids are the Library's own: ${others.map((s) => s.label).join(", ")} not searched.`);
      const found = await Promise.all(asked.map((s) => sourceCards(lib, s.id, a.q, by)));
      for (const [i, s] of asked.entries()) {
        const answer = found[i];
        if (!answer) {
          notes.push(`${s.label} did not answer.`);
          continue;
        }
        if (answer.refused) {
          notes.push(`${s.label}: ${answer.refused}`);
          continue;
        }
        const cards = answer.items;
        let kept = a.kind ? cards.filter((c) => c.kind === a.kind) : cards;
        if (a.roll && cards.some((c) => c.roll)) kept = kept.filter((c) => c.roll === a.roll);
        else if (a.roll && kept.length) notes.push(`${s.label} does not sort A-roll and B-roll: roll was not applied to it.`);
        if (a.since && kept.length) notes.push(`${s.label} does not say when a clip was added: since was not applied to it (captured is when a clip was shot).`);
        files.push(...kept.slice(0, limit).map((c) => hit(c, named(s.label))));
      }
      return {
        library: lib,
        ...(said ? { said } : {}),
        ...(others.length && !main ? { sources: ["Library", ...asked.map((s) => s.label)] } : {}),
        files,
        ...(notes.length ? { note: notes.join(" ") } : {}),
      };
    },
    media_import_folder: async (a) => {
      const by = Date.now() + ANSWER_BY_S * 1000; // the route itself may take 40 s
      const body: Args = { path: a.path };
      if (a.since) body.since = dateMs(a.since);
      if (a.folder) body.collectionId = a.folder;
      const r = await json<{ libraryId: string; imported: Args[]; scripts: Args[]; working?: number; copying?: string[] }>("/api/library/import-folder", "POST", body);
      const done = r.imported.filter((x) => x.versionId);
      const sorted = done.length ? await sortedLine(r.libraryId, done.map((x) => String(x.versionId)), SORT_WAIT_S.added, by) : null;
      return {
        imported: done.length,
        ...(sorted ? { said: sorted.said } : {}),
        files: r.imported.map((x) => ({ file: x.file, ...(x.versionId ? { version_id: x.versionId } : { error: x.error }) })),
        scripts: r.scripts,
        ...(r.working ? { still_importing: r.working } : {}),
        ...(r.copying?.length ? { still_copying: r.copying } : {}),
        note: [
          done.length ? "They are processed (transcript, description) in the background; editor_create can take them now and waits for them." : r.imported.length ? "" : "No media files there changed since then.",
          r.working || r.copying?.length ? "Some files are still coming in: call media_import_folder again with the same path and since to get their version_id (the ones in already come back at once)." : "",
          sorted?.left ? STILL_SORTING : "",
        ].filter(Boolean).join(" "),
      };
    },
    instagram_add_account: async (a) => {
      const acc = await json("/api/instagram/accounts", "POST", { username: String(a.handle ?? "").replace(/^@/, ""), run: "now", mine: a.mine === true });
      return pick(acc, ["id", "username", "jobs", "catalogCount"]);
    },
    instagram_comments: async (a) => {
      const acc = await json(`/api/instagram/accounts/${await accountOf(String(a.account))}?lite=1`);
      const rows = ((acc.catalog as Args[] | undefined) ?? []).filter((r) => r.url || r.shortcode);
      let chosen: Args[];
      if (Array.isArray(a.shortcodes) && a.shortcodes.length) {
        const want = new Set(a.shortcodes.map(String));
        chosen = rows.filter((r) => want.has(String(r.shortcode)));
      } else {
        const since = a.since ? dateMs(a.since) : 0;
        chosen = rows.filter((r) => (r.takenAt as number) >= since).sort((x, y) => (y.takenAt as number) - (x.takenAt as number));
      }
      chosen = chosen.slice(0, Math.max(1, Math.min(Number(a.posts ?? 10), 25)));
      if (!chosen.length) return { account: acc.username, posts: 0, comments: [], note: "No posts in that range: instagram_refresh pulls the account's newest posts first." };
      const urls = chosen.map((r) => String(r.url ?? `https://www.instagram.com/p/${r.shortcode}/`));
      // the Analyzer's own post pull, comments only; a post already pulled is not pulled again
      let posts = (await json<{ posts: Args[] }>("/api/instagram", "POST", { urls, recipe: { preset: "custom", jobs: ["comments"] }, run: "now" })).posts;
      // a post being pulled is pending (a post already in the Analyzer is pulled again, so its comments are new); once
      // it is done, its comments' own state: complete or capped (read them), failed, or skipped (none to pull)
      const status = (p: Args) => {
        if (p.status === "processing") return "pending";
        const s = String((p.comments as Args | undefined)?.status ?? "skipped");
        return s === "pending" ? "skipped" : s;
      };
      const end = Date.now() + 45_000;
      while (posts.some((p) => status(p) === "pending") && Date.now() < end) {
        await sleep(5000);
        posts = await Promise.all(posts.map((p) => (status(p) === "pending" ? json(`/api/instagram/${p.id}`) : p)));
      }
      const max = Math.max(1, Math.min(Number(a.max ?? 100), 500));
      const comments: Args[] = [];
      for (const p of posts.filter((p) => status(p) === "complete" || status(p) === "capped")) {
        const file = await json<{ comments: Args[] }>(`/api/instagram/${p.id}/comments`).catch(() => ({ comments: [] as Args[] }));
        for (const c of file.comments) {
          const j = c.judged as Args | undefined;
          if (j?.kind === "spam") continue;
          comments.push({ post: p.shortcode, text: c.text, likes: c.likeCount, replies: c.replyCount, ...(j ? { kind: j.kind } : {}) });
        }
      }
      comments.sort((x, y) => Number(y.likes ?? 0) - Number(x.likes ?? 0));
      const pending = posts.filter((p) => status(p) === "pending").map((p) => p.shortcode);
      const failed = posts.filter((p) => status(p) === "failed").map((p) => p.shortcode);
      return {
        account: acc.username,
        posts: posts.length,
        comments: comments.slice(0, max),
        total: comments.length,
        ...(pending.length ? { pending, note: "Still pulling these posts' comments: call instagram_comments again in a minute for them." } : {}),
        ...(failed.length ? { failed } : {}),
      };
    },
    list_scheduled_tasks: async () => ({ tasks: (await json<{ items: Args[] }>("/api/automations")).items.map(taskOut) }),
    schedule_task: async (a) => {
      const body = pick(a, ["name", "prompt", "schedule", "timezone", "destination", "project", "enabled"]);
      if (a.project === null) body.project = null;
      return taskOut(a.id ? await json(`/api/automations/${encodeURIComponent(String(a.id))}`, "PATCH", body) : await json("/api/automations", "POST", body));
    },
    run_scheduled_task_now: async (a) => taskOut(await json(`/api/automations/${encodeURIComponent(String(a.id))}/run`, "POST")),
    delete_scheduled_task: async (a) => {
      const found = (await json<{ items: Args[] }>("/api/automations")).items.find((t) => t.id === a.id);
      if (!found) throw new ToolError("Not found, or not this account's.");
      await sure(`Delete the scheduled task "${String(found.name)}"?`);
      return json(`/api/automations/${encodeURIComponent(String(a.id))}`, "DELETE");
    },
    get_work_prefs: async () => json("/api/work-prefs"),
    upload_file: async (a) => {
      const p = String(a.path ?? "");
      if (!p.startsWith("/")) throw new ToolError("Give the file's full path on your computer, such as /Users/you/Movies/clip.mov.");
      const name = p.split("/").pop()!;
      const r = await json<{ id: string; partSize: number }>("/api/assistant/files", "POST", { name, mime: mimeOf(name), size: Number(a.size) });
      const parts = Math.ceil(Number(a.size) / r.partSize);
      const file = `'${p.replace(/'/g, "'\\''")}'`;
      // ponytail: a POSIX shell (macOS, Linux); Windows needs its own command
      const command = `for n in $(seq 1 ${parts}); do dd if=${file} bs=${r.partSize} skip=$((n-1)) count=1 2>/dev/null | curl -fsS -X PUT --data-binary @- ${origin}/api/upload/${uploadLink(user.username, r.id)}/$n >/dev/null || break; done`;
      return { file: r.id, command, then: "When it ends, use_file with this file id. The link works for an hour." };
    },
    set_work_prefs: async (a) => {
      const body = pick(a, ["talk", "check", "makes"]);
      if (a.editor !== undefined) body.editor = a.editor;
      if (a.job !== undefined) body.job = a.job;
      if (!Object.keys(body).length) throw new ToolError("Nothing to change: give talk, check, editor, makes or job.");
      return json("/api/work-prefs", "PUT", body);
    },
    setup_status: async () => {
      const route = routeFor(user.username, user.role === "admin", "notes");
      const keys = myKeys(user.username);
      const projects = await ws<Args[]>("/projects");
      return {
        ai: route
          ? { connected: true, name: route.instance.name, driver: route.instance.driver, on: deviceName(route.device) }
          : { connected: false, note: "No AI yet: connect Claude Code or Codex on a paired Mac (Settings → Providers)." },
        logins: readConnectors(user.username).accounts.map((a) => ({ platform: a.platform, handle: a.handle, via: a.via })),
        keys: MY_KEYS.map((k) => ({ env: k.env, name: k.name, what: k.what, saved: !!keys[k.env] })),
        projects: projects.length,
        ...setupView(await json<SetupView>("/api/setup")),
      };
    },
    save_setup: async (a) => setupView(await json<SetupView>("/api/setup", "PUT", pick(a, ["tools", "plan", "done"]))),
    ask_secret: async (a) => {
      someoneThere();
      const env = MY_KEYS.find((k) => k.env === a.env);
      if (!env) throw new ToolError(`${String(a.env)} is not a key the app takes.`);
      // only the name and the reason: any other argument (a value included) is dropped unread
      await askSecret(user.username, env.env, String(a.why ?? "").slice(0, 300), jobTurn(auth.get("authorization") ?? undefined) ?? undefined);
      return { status: "asked", note: "The user will type the key into a secure box in the chat. It does not come to you; carry on without it until it's saved." };
    },
    offer_choices: async (a) => {
      const choices = (Array.isArray(a.choices) ? a.choices : []).map((x) => String(x).replace(/\s+/g, " ").trim().slice(0, 60)).filter(Boolean);
      if (choices.length < 2 || choices.length > 4) throw new ToolError("Give 2 to 4 short answers.");
      const turn = jobTurn(auth.get("authorization") ?? undefined);
      if (turn) noteChoices(user.username, turn, [...new Set(choices)]);
      return { status: "shown", note: "The buttons are under your reply: end the reply and wait for the answer." };
    },
    ask_folder: async (a) => {
      someoneThere();
      const turn = jobTurn(auth.get("authorization") ?? undefined);
      if (turn) askFolder(user.username, turn, String(a.why ?? ""));
      return { status: "asked", note: "The button is under your reply: end the reply and wait for the folder." };
    },
    navigate: async (a) => {
      someoneThere();
      return { status: "opening", path: await navigateTo(user.username, String(a.path ?? "")) };
    },
    // the card's src and href are the site's own routes, so the browser's cookie passes the same checks this call did
    show_video: async (a) => {
      let link = a.link;
      let version = a.version;
      if (a.edit || a.draft) {
        // this editor files each draft's preview in Review: the draft plays from there
        if (!a.edit || !a.draft) throw new ToolError("An AI Editor preview needs edit and draft (editor_get lists them).");
        const e = await json(`/api/editor/${encodeURIComponent(String(a.edit))}`);
        const previews = (e.previews as Record<string, { assetId: string; n: number }> | undefined) ?? {};
        // an editor plug-in answering this path has no previews map: a draft it filed in Review carries review { asset, n }
        const filed = ((e.drafts as Args[] | undefined) ?? []).find((d) => d.name === a.draft)?.review as { asset: string; n: number } | undefined;
        const p = previews[String(a.draft)] ?? (filed ? { assetId: filed.asset, n: filed.n } : undefined);
        if (!p) throw new ToolError("That draft has no preview in Review yet: editor_get says where each draft's preview is.");
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
  offer_choices: "Offering answers",
  ask_folder: "Asking for a folder",
  use_file: "Sending your file",
  notes_get: "Reading the Video Note",
  save_setup: "Saving your setup",
  ask_secret: "Asking for a key",
  get_work_prefs: "Checking how you like to work",
  upload_file: "Sending a file",
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
  list_scheduled_tasks: "Looking at your scheduled tasks",
  schedule_task: "Saving the scheduled task",
  run_scheduled_task_now: "Running the scheduled task",
  delete_scheduled_task: "Deleting the scheduled task",
  editor_get: "Opening the edit",
  editor_run: "Starting an AI Editor job",
  editor_go: "Carrying on the edit",
  instagram_posts: "Reading your Instagram posts",
  instagram_refresh: "Refreshing Instagram",
  editor_create: "Starting a new edit",
  media_import_folder: "Bringing your folder into the Media Library",
  media_search: "Searching the Media Library",
  media_folders: "Looking at the Media Library's folders",
  instagram_add_account: "Adding the Instagram account",
  instagram_comments: "Reading the comments",
};
const PAGES: Record<string, string> = { review: "Review", workshop: "the Workshop", editor: "the AI Editor", settings: "Settings", instagram: "the Analyzer", analyzer: "the Analyzer" };
export const stepFor = (name: string, args: Args, plugged: Record<string, string> = {}): string =>
  name === "navigate"
    ? `Opening ${PAGES[String(args.path ?? "").split(/[/?]/)[1] ?? ""] ?? "the page"}`
    : (plugged[name] ?? STEPS[name] ?? MODULE_STEPS[name] ?? name.replace(/_/g, " "));

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
    case "editor_create":
      return r.id
        ? { card: { id: `edit:${r.id}:new`, kind: "edit", title: String(r.name ?? "New edit"), href: `/editor/${encodeURIComponent(String(r.id))}`, status: r.status === "started" ? "running" : "done", detail: r.status === "started" ? "The AI Editor is working on it" : "Made, not started" } }
        : null;
    case "use_file": {
      if (a.to === "library") return r.said && r.href ? { card: { id: `library:${String(r.href)}`, kind: "link", title: "Media Library", href: String(r.href), status: "done", detail: String(r.said) } } : null;
      // Caption Studio: the card runs while the captions are being made (captions-job.ts ends it, and says so in the chat)
      if (a.to === "captions")
        return r.id ? { card: { id: `captions:${r.id}`, kind: "captions", title: String(r.name ?? "Caption Studio"), href: String(r.href), status: r.captioning ? "running" : "done", detail: r.captioning ? "Making the captions" : "In Caption Studio, not transcribed" } } : null;
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
    case "schedule_task":
    case "run_scheduled_task_now":
      return r.id
        ? {
            card: {
              id: `automation:${r.id}`, kind: "automation", title: String(r.name ?? "Scheduled task"), href: `/settings/automations?task=${encodeURIComponent(String(r.id))}`,
              ...(name === "run_scheduled_task_now"
                ? { status: "running" as const, detail: "Running now: the answer lands in its chat" }
                : { status: "done" as const, detail: r.enabled ? (r.next_run ? `Next run ${new Date(String(r.next_run)).toLocaleString("en-GB", { timeZone: String(r.timezone ?? "UTC"), dateStyle: "medium", timeStyle: "short" })}` : "Not scheduled") : "Paused" }),
            },
          }
        : null;
    default:
      return null;
  }
}

/** sure() put its question on a card: the call ends here, and runs again when the person presses Yes. */
class Asked extends Error {}

/**
 * One tool call. `confirmed`: the person pressed Yes on the card this same call put up (assistant.ts runs it again
 * as them, with their own login instead of the reply's token), so sure() goes through.
 */
async function callTool(call: Call, auth: Headers, origin: string, user: SessionUser, name: string, args: Args, plugged: PluginTools, confirmed = false) {
  const api = apiOf(call, auth);
  const turn = jobTurn(auth.get("authorization") ?? undefined);
  const ctx: ToolContext = {
    user,
    origin,
    api,
    json: async <T = Args>(path: string, method = "GET", body?: unknown) => (await (await api(path, method, body)).json()) as T,
    sure: async (question) => {
      // outside the dock the caller's own AI app asks its own way; in the dock the question waits on a card
      if (confirmed || !turn) return;
      if (!askConfirm(user.username, turn, question, { tool: name, args })) throw new ToolError("Too many questions are waiting for the user under this reply: end it and let them answer.");
      throw new Asked(question);
    },
  };
  const plug = plugged.handlers.get(name);
  const own = notHere(name) ? undefined : MODULE_HANDLERS.get(name);
  const handler = plug ? (a: Args) => plug(a, ctx) : own ? (a: Args) => own(a, ctx) : tools(call, auth, origin, user, ctx.sure)[name];
  if (turn) noteStep(user.username, turn, stepFor(name, args ?? {}, plugged.steps));
  try {
    if (!handler) throw new ToolError(`Unknown tool ${name}.`);
    if ((ASSISTANT_TOOLS.has(name) || DOCK_ONLY.has(name)) && !isJob(auth) && !confirmed) throw new ToolError(`${name} is for the assistant only.`);
    const result = await handler(args ?? {});
    if (turn && result && typeof result === "object" && !Array.isArray(result)) {
      const cards = plug ? plugged.work : MODULES.filter((m) => name in m.handlers).map((m) => m.work).filter((w) => !!w);
      const work = cards.map((w) => w(name, args ?? {}, result as Args)).find((c) => !!c) ?? workFor(name, args ?? {}, result as Args);
      if (work) noteWork(user.username, turn, work.card, work.only);
    }
    // a tool's pictures for the AI to look at (`_images`: a line saying what each is, and its JPEG): after its answer, each as a picture
    const { _images: images, ...said } = (result && typeof result === "object" && !Array.isArray(result) ? result : {}) as Args & { _images?: Array<{ text: string; jpeg: string }> };
    const content: Content[] = Array.isArray(result)
      ? (result as Content[])
      : Array.isArray(images)
        ? [{ type: "text", text: JSON.stringify(said, null, 1) }, ...images.flatMap((i): Content[] => [{ type: "text", text: i.text }, { type: "image", mimeType: "image/jpeg", data: i.jpeg }])]
        : [{ type: "text", text: JSON.stringify(result, null, 1) }];
    // an AI app outside the dock draws some answers as a card (mcp-cards.ts): its data rides beside the text, for the card alone
    // (never for a plug-in's answer to a tool of the same name: its answer is its own shape)
    const card = !turn && !confirmed && !plug && !isJob(auth) && hasCard(name) ? cardFor(name, args ?? {}, answerOf(result, content), origin, mediaLinks(auth.get("authorization"), user.username, origin)) : null;
    return card ? { content, _meta: { card } } : { content };
  } catch (e) {
    if (e instanceof Asked)
      return { content: [{ type: "text", text: `Asked the user: "${e.message}" Nothing has been changed. It is done when they press Yes on the card under your reply: say that you asked, end your reply and wait.` }] };
    return { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true };
  }
}

/** A tool's answer as the object a card is made from: the result itself, or what its first text block holds (get_review answers in blocks). */
function answerOf(result: unknown, content: Content[]): Args {
  if (result && typeof result === "object" && !Array.isArray(result)) return result as Args;
  try {
    const first = content[0];
    const parsed = first?.type === "text" ? (JSON.parse(first.text) as unknown) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : {};
  } catch {
    return {};
  }
}

/** Said to an AI app outside the dock, with the guide: the dock has no cards. */
const CARDS_GUIDE = `Cards: a script (workshop_session and the tools that write one), footage (media_search), a Review video with its
comments (get_review), an edit (editor_get, editor_create) and an account's posts (instagram_posts) show in the chat as
a card, where the app can draw one. The card already shows the content, plays the video where it may, and has its own
buttons (open it in Creator Toolset, resolve a comment): do not repeat it line by line. Say what you did or found in a
sentence or two, and what the user could do next.

Here you are the writer: write and change scripts yourself with workshop_new_piece and workshop_edit_piece, so the user
sees them saved at once. workshop_chat asks the Workshop's own writer, which needs a computer paired to the account:
use it only when the user asks for that writer.`;

/** One JSON-RPC message in, its answer out (null for a notification). `origin` starts the links the tools hand back. */
export async function handle(call: Call, auth: Headers, msg: Args, origin: string, user: SessionUser, plugged: PluginTools = pluginToolsOf([])): Promise<Args | null> {
  if (msg.id === undefined) return null;
  const params = (msg.params ?? {}) as Args;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  switch (msg.method) {
    case "initialize":
      return ok({
        protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18",
        // the dock's assistant gets tools only; an AI app outside also reads the card's page (resources)
        capabilities: isJob(auth) ? { tools: {} } : { tools: {}, resources: {} },
        serverInfo: { name: "creator-toolset", version: "1.0.0" },
        // a plug-in's paragraph stays last: it speaks for this install
        instructions: [INSTRUCTIONS, mainSource() ? "" : FINALS_GUIDE, isJob(auth) ? "" : CARDS_GUIDE, plugged.guide].filter(Boolean).join("\n\n"),
      });
    case "ping":
      return ok({});
    case "tools/list": {
      const dock = isJob(auth);
      const listed = [...TOOLS, ...MODULE_DEFS.filter((d) => dock || !d.dockOnly), ...(dock ? ASSISTANT_DEFS : ASSISTANT_DEFS.filter((d) => KEY_TOO.has(d.name)))];
      // skill_read (mcp-tools/skills.ts): only while the account has a skill on, in a reply someone is there for
      const skills = dock && !unattended(user.username, jobTurn(auth.get("authorization") ?? undefined) ?? "") && (await dockSkills(user.username)).length > 0;
      // dockOnly says who gets a tool; it is not part of the listing
      return ok({ tools: [...listed.filter((t) => !plugged.replaced.has(t.name) && !notHere(t.name) && (skills || t.name !== "skill_read") && (t.name !== "editor_style_use" || hasStyle(user.username))), ...plugged.defs].map(({ name, description, inputSchema }) =>
          // the labels are for an AI app outside (it asks before a tool that can remove); the dock's list stays as it was
          dock ? { name, description, inputSchema } : { name, title: annotationsOf(name).title, description, inputSchema, annotations: annotationsOf(name), ...(cardToolMeta(name) && !plugged.handlers.has(name) ? { _meta: cardToolMeta(name) } : {}) },
        ) });
    }
    // the card's page (mcp-cards.ts): one resource, read once by the AI app and kept
    case "resources/list":
      return ok({ resources: isJob(auth) ? [] : cardResourceList() });
    case "resources/templates/list":
      return ok({ resourceTemplates: [] });
    case "resources/read": {
      // any card name answers with the page as it is now: an app may still hold an older name from its last listing
      if (!String(params.uri ?? "").startsWith("ui://creator-toolset/card")) return { jsonrpc: "2.0", id: msg.id, error: { code: -32002, message: "Resource not found" } };
      return ok({ contents: [cardResource(origin)] });
    }
    case "tools/call":
      return ok(await callTool(call, auth, origin, user, String(params.name), (params.arguments ?? {}) as Args, plugged));
    default:
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${String(msg.method)}` } };
  }
}

/**
 * How each tool is labelled for the AI apps (MCP annotations, which ChatGPT and Claude ask for): READS only read,
 * REPLACES can remove or overwrite something the user has, ADDS add or change without losing anything. OUTSIDE reach
 * past this account (a link for other people, a pull from Instagram). A tool in none of them (a plug-in's) is labelled
 * as one that can remove, so an AI app asks before it runs.
 */
const READS = new Set("captions_get captions_list design_get editor_get editor_list finals_pieces get_review get_work_prefs instagram_post instagram_posts instagram_search list_reviews list_scheduled_tasks media_folders media_get media_search notes_list setup_status skill_read workshop_projects workshop_session workshop_sessions workshop_wait navigate show_video offer_choices".split(" "));
const REPLACES = new Set("delete_scheduled_task design_update editor_delete editor_stop editor_update finals_piece_trash finals_piece_update forget media_update review_trash review_update workshop_edit_piece workshop_sources workshop_update_session".split(" "));
const ADDS = new Set("channel_posts instagram_comments review_folders ask_folder ask_secret captions_export design_make editor_create editor_retry editor_run editor_style_save editor_style_use finals_link_session instagram_add_account instagram_refresh instagram_save media_add_to_folder media_import_folder media_share notes_get remember resolve_comment review_comment review_set_approval review_share run_scheduled_task_now save_setup schedule_task set_work_prefs upload_file use_file workshop_chat workshop_new_piece workshop_new_session workshop_set_project".split(" "));
const OUTSIDE = new Set(["channel_posts", "instagram_comments", "instagram_add_account", "instagram_refresh", "instagram_save", "media_share", "review_share"]);
export const LABELLED = new Set([...READS, ...REPLACES, ...ADDS]);
export const annotationsOf = (name: string) => ({
  title: name.replace(/_/g, " ").replace(/^./, (ch) => ch.toUpperCase()),
  readOnlyHint: READS.has(name),
  destructiveHint: !READS.has(name) && !ADDS.has(name),
  openWorldHint: OUTSIDE.has(name),
});

/** The MCP route. `plugins` (the server's plug-ins, boot.ts) add their tools to the list and the calls; checked here, once. */
export function mcpApp(call: Call, plugins: ServerPlugin[] = []) {
  const app = new Hono<{ Variables: AuthVars }>();
  const plugged = pluginToolsOf(plugins);
  setInstallGuide(plugged.guide);
  // Yes on a card (assistant.ts): the call it stands for runs again as the person who pressed it
  setConfirmRunner(async (user, headers, origin, tool, args) => {
    const inner: Call = (path, init) => innerCall.run(user, () => call(path, init));
    const r = await callTool(inner, headers, origin, user, tool, (args ?? {}) as Args, plugged, true);
    return { ok: !("isError" in r), text: r.content.map((x) => (x.type === "text" ? x.text : "")).join(" ") };
  });
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
