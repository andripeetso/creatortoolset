/**
 * The session stages, shared by the server (api/lib/workshop/types.ts) and the browser (src/lib/workshop.ts). No imports, so the
 * browser bundle never pulls in the server's transition code.
 */

/** Idea → Writing → Ready → In Production (filming) → Editing → Ready to post → Published, or Shelved. Missing on old records = draft. */
export const SESSION_STATUSES = ["draft", "writing", "ready", "production", "editing", "toPost", "published", "shelved"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** A draft made from a session: generating until it is ready or fails. */
export type DraftStatus = "generating" | "ready" | "error";
/** A chat reply: thinking until it is done or fails. */
export type ReplyStatus = "thinking" | "done" | "error";
/** What the AI proposed (a web search, an accuracy check): open until the author says yes or no. */
export type ProposalStatus = "open" | "accepted" | "declined";
/** A freelancer's mark on a share link. */
export type ShareProgressState = "producing" | "done";

/** A chat reply the author stopped ends with this error: a Stop, not a failure (the chat hides it). */
export const TURN_STOPPED = "Stopped";
