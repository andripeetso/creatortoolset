/**
 * The in-app assistant's dock (api/assistant.ts, src/components/assistant): one conversation per account.
 * GET /api/assistant → AssistantView. POST /api/assistant/turn { text } → 202 with the same view (the reply is
 * "thinking" until its status changes; the dock polls while one is). A pending key request is a secure box in the
 * dock; its value never comes back through this API, only the saved key's last four digits in a note.
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
  /** A user message's attachments as shown in the chat: pictures by name (served by GET /api/assistant/images/:id), pastes by name. */
  images?: Array<{ id: string; name: string }>;
  pasted?: string[];
  /** Videos and recordings sent with a user message (api/assistant-files.ts), by name. */
  files?: Array<{ id: string; name: string }>;
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
}

/** POST /api/assistant/turn's body. */
export interface AssistantTurnInput {
  text: string;
  images?: AssistantImage[];
  pasted?: AssistantPaste[];
  /** Ids of videos or recordings uploaded first (POST /api/assistant/files, parts, complete). */
  files?: string[];
  /** Folders dropped in the Mac app: their absolute paths on the user's computer, pointed at where they lie. */
  paths?: string[];
  context?: AssistantContext;
}

/** A video or recording dropped in the chat, uploaded before the message goes (api/assistant-files.ts; kept 7 days). */
export interface AssistantFile {
  id: string;
  name: string;
  mime: string;
  size: number;
}

/** Where the assistant's use_file can send a dropped file: Video Notes, Review or Caption Studio. */
export const FILE_USES = ["notes", "review", "captions"] as const;
export type AssistantFileUse = (typeof FILE_USES)[number];

/** An earlier conversation, kept when a new one starts (Earlier chats in the dock). */
export interface AssistantPast {
  id: string;
  /** Its first message, shortened. */
  title: string;
  /** When its last message was written. */
  at: number;
  count: number;
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
  /** A page the assistant opened for the user (navigate); the dock moves there and acks it. */
  navigate: string | null;
}
