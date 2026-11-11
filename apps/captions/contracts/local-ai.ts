import type { PlanId } from "./plans";
import type { Driver } from "./providers";

/**
 * The AI command-line tools on this Mac that setup can connect (api/lib/local-ai.ts): what was found, whether it is
 * signed in, whether a check passed, and whether Creator Toolset is added to it. Plain words only in `message`;
 * `raw` is the CLI's own text, shown only under Details.
 */

export type CliId = "claude" | "codex" | "gemini";

/**
 * The vendors' own install lines: the last-resort Copy only (setup installs with the vendor's route itself, api/lib/
 * local-ai.ts installCli). Fixed text, nothing typed in. Codex's and Gemini's lines need Node.js.
 */
export const INSTALL_LINE: Record<CliId, string> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "npm install -g @openai/codex",
  gemini: "npm install -g @google/gemini-cli",
};
export type LocalAiId = CliId;

export interface LocalAiRow {
  id: LocalAiId;
  name: string; // "Claude Code" | "Codex" | "Gemini"
  kind: "cli";
  found: boolean;
  version?: string; // first line of --version, max 120 chars
  signedIn: boolean | null; // null: unknown (gemini, or the probe could not tell)
  plan?: PlanId; // only when the CLI reports one
  connected: boolean; // own instance "local-<driver>" exists, enabled, lastCheck.ok
  lastCheck?: { ok: boolean; at: number; ms: number };
  mcp: "added" | "off" | "update" | "n/a"; // n/a: gemini
  updateCommand?: string; // only when mcp === "update"
}

export interface LocalAiView {
  local: boolean; // false when CT_LOCAL is not "1"; rows is then []
  rows: LocalAiRow[];
  /**
   * the other AIs the Mac app runs: Grok, Meta and Cursor always (setup installs and signs them in; `signedIn` read from the
   * file their sign-in saves, null when not found), the rest only when on this Mac (setup connects them as they are set up)
   */
  others?: Array<{ id: Driver; found: boolean; signedIn: boolean | null; connected: boolean }>;
}

/**
 * "unsupported": this CLI can't be the app's own AI (the Mac relay has no runner for it). "outdated": the copy on this
 * Mac is too old for today's models; the page installs the current one and connects again. "ready" with a `message`:
 * connected, and the plan's limit is reached until the time the message names. "plan": the AI turned the account itself
 * away (no plan that includes it, contracts/plans.ts noPlanLine); trying again won't change that.
 */
export type ConnectState = "missing" | "mac" | "signin" | "failed" | "ready" | "unsupported" | "outdated" | "plan";

export interface ConnectResult {
  state: ConnectState;
  signedIn: boolean | null;
  answered: boolean | null; // null: the check did not run
  ms?: number;
  message?: string; // plain words only
  raw?: string; // raw CLI text, shown only under Details
}

/** Sign-in and install: `message` is one plain sentence; `raw` is the command's own output, shown only under Details. */
export interface SignInResult {
  ok: boolean;
  message?: string;
  raw?: string;
  /** a sign-in that asks the person to confirm a code on the vendor's page (Meta's): the code */
  code?: string;
}

export interface McpResult {
  ok: boolean; // every target now holds the new key
  added: CliId[];
  failed: Array<{ id: CliId; message: string }>;
  message?: string;
}
