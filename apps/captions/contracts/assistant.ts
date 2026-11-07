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
}

/** A key the assistant asked for (ask_secret): shown as a password box in the dock. */
export interface AssistantPending {
  env: string;
  name: string;
  why: string;
}

export interface AssistantView {
  provider: AssistantProvider;
  messages: AssistantMessage[];
  pending: AssistantPending | null;
  /** A page the assistant opened for the user (navigate); the dock moves there and acks it. */
  navigate: string | null;
}
