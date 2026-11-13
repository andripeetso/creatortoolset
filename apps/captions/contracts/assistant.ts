/**
 * The in-app assistant's dock (api/assistant.ts, src/components/assistant): one open chat per account, plus earlier ones.
 * GET /api/assistant → AssistantView. POST /api/assistant/turn { text } → 202 with the same view (the reply is
 * "thinking" until its status changes; the dock polls while one is). A pending key request is a secure box in the
 * dock; its value never comes back through this API, only the saved key's last four digits in a note.
 *
 * Many chats (a view with `chats: true`): every chat by its id, none of them made the open one.
 *   GET  /api/assistant/chats            → { chats: AssistantChat[] }, newest first, the open chat among them
 *   POST /api/assistant/chats            → 201 { id }: a new empty chat (the open chat stays open)
 *   GET  /api/assistant/chats/:id        → AssistantView of that chat (`past` is empty there: the list is GET /chats)
 *   POST /api/assistant/chats/:id/turn   → AssistantTurnInput, 202 with that chat's view (404: the chat is gone)
 *   POST /api/assistant/chats/:id/settle { settled: boolean } → { chats }: done with it, kept (`settled` in the lists)
 * Replies in different chats are written at the same time, up to 3 per account (MAX_RUNNING, api/assistant.ts); in one
 * chat one at a time, in order. Stop ({ reply }), approvals and confirms are found by their own ids in any chat.
 */

/** "none" = no AI connected yet (the dock can't talk), "claude" = Claude Code on a paired Mac (the only one for now), "other" = any other provider. */
export type AssistantProvider = "none" | "claude" | "other";

export interface AssistantMessage {
  id: string;
  /** "note" = something the app recorded, such as a key saved. */
  role: "user" | "assistant" | "note";
  text: string;
  at: number;
  /** An assistant reply: thinking until it's done or fails. */
  status?: "thinking" | "done" | "error";
  /** A reply: when it began working (one queued or waiting for its videos starts later than `at`). The dock's "Working for" counts from it. */
  started?: number;
  /** A reply that ended: how long it worked (ms), shown as "Worked for 1m 12s". */
  took?: number;
  /** What the reply did on the way, one line per tool it used ("Looking through Review"), shown as it works. */
  steps?: string[];
  /** What the reply started or opened that the user can look at (a Workshop session, an edit, a link): a card each. */
  work?: AssistantWork[];
  /** Things the reply asked to do on the user's Mac (a command, a file change, a read outside its folder): Allow / Deny each. */
  approvals?: AssistantApproval[];
  /** Videos the reply shows in the chat (show_video): a small player each. */
  media?: AssistantMedia[];
  /** Answers the reply offers as buttons (offer_choices): a press sends that one as the user's message. */
  choices?: string[];
  /** The reply asks for a folder on the user's computer (ask_folder): in the Mac app a Choose a folder button under it; the chosen folder goes with their next message. */
  folderAsk?: { why: string };
  /** Questions the reply put before deleting, publishing or sending something: a Yes / No card each. */
  confirms?: AssistantConfirm[];
  /** A user message's attachments as shown in the chat: pictures by name (served by GET /api/assistant/images/:id), pastes by name. */
  images?: Array<{ id: string; name: string }>;
  pasted?: string[];
  /** Videos and recordings sent with a user message (api/assistant-files.ts), by name; `uploading` until the file is in. */
  files?: Array<{ id: string; name: string; uploading?: true }>;
  /** Videos dropped in the Mac app with a user message: their paths on the user's computer (nothing uploaded). */
  localFiles?: string[];
  /**
   * A reply that carries on once a file on the user's computer is on the server (a tool needs it there): the dock that
   * still has that file uploads it, then names the upload (`id`). `to` is the tool's name ("Review").
   */
  send?: { path: string; name: string; to: string; id?: string };
  /**
   * A reply that hasn't started (status "thinking"): it waits for the message's videos to finish uploading ("videos",
   * with how many), or for the reply before it to end ("reply"). `text` is the line to show: "Waiting for 2 videos".
   */
  wait?: { for: "videos" | "reply"; videos?: number; text: string };
  /** Folders dropped in the Mac app with a user message: their paths on the user's computer (nothing uploaded). */
  folders?: string[];
  /** The highlighted text a user message asked about. */
  quote?: string;
  /** A scheduled task's run: its prompt, posted as the user's message (api/automations.ts). */
  task?: { id: string; name: string };
}

/**
 * One thing a reply started or opened, as a card in the chat (one per thing: the same id updates it). href is an app
 * path ("/workshop/sessions/<id>") or, for kind "link", a full URL. A running card may stay running after the reply
 * ends: the Workshop's writer and an editor job carry on by themselves.
 */
export interface AssistantWork {
  id: string;
  kind: "workshop" | "edit" | "review" | "automation" | "link" | "notes" | "captions";
  title: string;
  href: string;
  status: "running" | "done" | "failed";
  detail?: string;
}

/**
 * A video shown in the chat: src plays it (a same-origin route the signed-in browser can stream, with byte ranges),
 * poster is its still, href the app page that opens it (/review/<id>?v=<n>). duration in seconds.
 */
export interface AssistantMedia {
  id: string;
  kind: "video";
  title: string;
  src: string;
  poster?: string;
  href: string;
  duration?: number;
}

/**
 * One thing the assistant asked to do on the user's Mac. summary says it in plain words, detail is the exact command
 * or path. POST /api/assistant/approvals/:id { allow } answers it; unanswered after 10 minutes it is "expired" (a no).
 */
export interface AssistantApproval {
  id: string;
  tool: string;
  summary: string;
  detail: string;
  at: number;
  status: "waiting" | "allowed" | "denied" | "expired";
}

/**
 * A question the assistant put before a tool deleted, published or sent something. POST /api/assistant/confirms/:id
 * { yes } answers it: Yes runs the tool as the person and the card says how it went ("done", or "failed" with why in
 * `result`); No drops it ("no").
 */
export interface AssistantConfirm {
  id: string;
  question: string;
  at: number;
  status: "waiting" | "done" | "failed" | "no";
  result?: string;
}

/** A key the assistant asked for (ask_secret): shown as a password box in the dock. */
export interface AssistantPending {
  env: string;
  name: string;
  why: string;
}

/** A picture sent with a message (dropped, pasted or a screenshot): PNG, JPEG, WebP or GIF, base64 without the data: prefix. */
export interface AssistantImage {
  name: string;
  type: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
  data: string;
}

/** Long text pasted into the box, sent as a file beside the message instead of in it. */
export interface AssistantPaste {
  name: string;
  text: string;
}

/** What the user is looking at when they send (the dock fills it in): the page, and any text they highlighted. */
export interface AssistantContext {
  path: string;
  title: string;
  /** Text highlighted on the page and sent to the chat ("Ask about this"). */
  selection?: string;
  /** A few lines that say what's on screen: the page's headings and the open item's name. */
  visible?: string;
  /** The browser's IANA time zone, so a task the assistant schedules runs on the person's clock. */
  timezone?: string;
  /** Sent from the Mac app, whose own open panel can choose a folder (ask_folder). */
  mac?: boolean;
}

/** POST /api/assistant/turn's body. */
export interface AssistantTurnInput {
  text: string;
  images?: AssistantImage[];
  pasted?: AssistantPaste[];
  /**
   * Ids of videos or recordings (POST /api/assistant/files). One may still be uploading: the message is saved at once and
   * its reply waits (`wait`) until the last part is in, then runs. More messages while a reply waits or runs queue behind it.
   */
  files?: string[];
  /**
   * The client keeps uploading this message's videos after its reply ends (`videosLater` on the view): the reply starts at
   * once, is told which videos are still on their way, and the tools that take them wait for them.
   */
  later?: true;
  /** Videos dropped in the Mac app: their absolute paths on the user's computer, read where they are (nothing uploads). */
  localFiles?: string[];
  /** Folders dropped in the Mac app: their absolute paths on the user's computer, pointed at where they lie. */
  paths?: string[];
  context?: AssistantContext;
}

/** A video or recording dropped in the chat, uploaded in parts while the message goes (api/assistant-files.ts; kept 7 days). */
export interface AssistantFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Where the assistant's use_file can send a dropped file: Video Notes, Review, Caption Studio or the Media Library. */
export const FILE_USES = ["notes", "review", "captions", "library"] as const;
export type AssistantFileUse = (typeof FILE_USES)[number];

/** An earlier conversation, kept when a new one starts (Earlier chats in the dock). */
export interface AssistantPast {
  id: string;
  /** Its first message, shortened. */
  title: string;
  /** When its last message was written. */
  at: number;
  count: number;
  /** A reply is still being written, waiting for its videos or queued in it (New chat left it running). */
  working?: true;
  /** Settled (POST /chats/:id/settle) and nothing new in it since. */
  settled?: true;
}

/** One chat in GET /api/assistant/chats. */
export interface AssistantChat {
  id: string;
  /** Its first message, shortened, or a scheduled task's name; "Conversation" while it is empty. */
  title: string;
  /** Its newest message's time (ms); an empty chat's, when it was made. */
  at: number;
  /** Its newest message with words, on one line, shortened. */
  last: string;
  count: number;
  /** The web dock's open chat (GET /api/assistant). */
  open?: true;
  /** A reply is being written, waits for its videos, or waits its turn in it. */
  working?: true;
  /** A reply in it waits for the person: an Allow / Deny, a Yes / No card, or a key's box. */
  asks?: true;
  /** Settled (POST /chats/:id/settle) and nothing new in it since: folded away on every device. */
  settled?: true;
}

export interface AssistantView {
  /** The open chat's id (a scheduled task posts in a chat by id; ?chat=<id> on any page opens one). */
  id: string;
  provider: AssistantProvider;
  /** The AI's name ("Codex", "Claude Code (work)"), "" when none is connected. */
  aiName: string;
  /** Whether that AI has Creator Toolset's tools (Claude Code, Codex, Gemini CLI and Grok; the others answer from the message). */
  tools: boolean;
  messages: AssistantMessage[];
  /** Earlier conversations, newest first. */
  past: AssistantPast[];
  pending: AssistantPending | null;
  /** This server takes a message whose videos are still uploading (POST /turn with their ids) and queues messages sent
   *  while a reply runs. Absent on older servers: there a client posts only after its uploads are done. */
  sendNow?: true;
  /** A turn sent with `later` starts at once, without waiting for its videos. Absent on older servers: the reply waits. */
  videosLater?: true;
  /** A page the assistant opened for the user (navigate); the dock moves there and acks it. One per account, from any chat. */
  navigate: string | null;
  /** This server has the many-chats routes (GET /chats, /chats/:id, its /turn) and writes replies in different chats at
   *  the same time. Absent on older servers: there only the open chat routes exist and replies run one at a time. */
  chats?: true;
}
