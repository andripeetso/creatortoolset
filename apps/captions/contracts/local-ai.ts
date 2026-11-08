import type { PlanId } from "./plans";

/**
 * The AI command-line tools on this Mac that setup can connect (api/lib/local-ai.ts): what was found, whether it is
 * signed in, whether a check passed, and whether Creator Toolset is added to it. Plain words only in `message`;
 * `raw` is the CLI's own text, shown only under Details.
 */

export type CliId = "claude" | "codex" | "gemini";
export type LocalAiId = CliId | "claude-desktop" | "chatgpt-desktop";

export interface LocalAiRow {
  id: LocalAiId;
  name: string; // "Claude Code" | "Codex" | "Gemini CLI" | "Claude desktop" | "ChatGPT desktop"
  kind: "cli" | "desktop"; // desktop rows are text only
  found: boolean;
  version?: string; // first line of --version, max 120 chars
  signedIn: boolean | null; // null: unknown (gemini, or the probe could not tell)
  plan?: PlanId; // only when the CLI reports one
  connected: boolean; // own instance "local-<driver>" exists, enabled, lastCheck.ok
  lastCheck?: { ok: boolean; at: number; ms: number };
  mcp: "added" | "off" | "update" | "n/a"; // n/a: gemini and desktop rows
  updateCommand?: string; // only when mcp === "update"
}

export interface LocalAiView {
  local: boolean; // false when CT_LOCAL is not "1"; rows is then []
  rows: LocalAiRow[];
}

/** "unsupported": this CLI can't be the app's own AI (the Mac relay runs Claude Code and Gemini CLI only). */
export type ConnectState = "missing" | "mac" | "signin" | "failed" | "ready" | "unsupported";

export interface ConnectResult {
  state: ConnectState;
  signedIn: boolean | null;
  answered: boolean | null; // null: the check did not run
  ms?: number;
  message?: string; // plain words only
  raw?: string; // raw CLI text, shown only under Details
}

export interface SignInResult {
  ok: boolean;
  message?: string;
}

export interface McpResult {
  ok: boolean; // every target now holds the new key
  added: CliId[];
  failed: Array<{ id: CliId; message: string }>;
  message?: string;
}
