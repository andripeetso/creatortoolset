/**
 * Paid outside services (the keys in Settings → API keys, `contracts/service-keys.ts`): what each call used, for the
 * Usage page and each key's row. Served by `GET /api/usage/services?since=<ms>`; the person's own calls, and an
 * admin's the server keys' too.
 */

/** One hour's calls for one service, one tool or process (`label`), one key and one workspace. */
export interface ServiceUsageLine {
  /** UTC hour, "2026-11-23T14" */
  hour: string;
  /** the key's env name, as in `contracts/service-keys.ts` ("APIFY_TOKEN", "DEEPGRAM_API_KEY" …) */
  service: string;
  /** the tool or process that made the calls, in Home names ("Content Analyzer: account posts") */
  label: string;
  /** whose key paid: the person's own, the server's, or the team budget's */
  whose: "own" | "server" | "team";
  calls: number;
  /** what the service bills by, in `unit` (audio minutes, characters, results, tokens, requests) */
  units: number;
  unit: string;
  /** what it cost, from the service's own answer where it gives one, else the price list; 0 when unknown */
  costUsd: number;
  /** the workspace the calls ran in, by id; absent for none */
  workspace?: string;
}

/** A service's own account limits or balance, read from the service where its API offers one. */
export interface ServiceLimit {
  service: string;
  whose: "own" | "server";
  /** "Monthly usage", "Credit balance", "Characters this month" */
  label: string;
  used?: number;
  /** with no `used`, a balance: what is left (Deepgram's credit) */
  limit?: number;
  unit: string;
  /** ms */
  resetsAt?: number;
  /** when it was read, ms */
  at: number;
}

/**
 * A key's monthly budget and what it spent this calendar month (UTC). Set per key: the person's own key, or the server's
 * (an admin's), for the whole key and, below that, for each workspace. At a budget the key's calls stop (in that workspace
 * alone, for a workspace's) until the next month or a higher budget. Set on Settings → API keys; Usage only shows them.
 *   PUT /api/usage/budgets/:service  { whose: "own" | "server", budget: number | null, workspace?: string }  (null = no limit)
 */
export interface KeyBudget {
  service: string;
  whose: "own" | "server";
  /** dollars a month for the whole key; null = no limit */
  budget: number | null;
  spent: number;
  /** each workspace that has a budget on this key or spent on it this month */
  workspaces: WorkspaceBudget[];
}

export interface WorkspaceBudget {
  /** the workspace's id */
  id: string;
  budget: number | null;
  spent: number;
}

/** The services whose calls say what they cost, so a budget can hold them (the others count requests only). */
export const BUDGET_SERVICES = ["DEEPGRAM_API_KEY", "ELEVENLABS_API_KEY", "PERPLEXITY_API_KEY", "APIFY_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "ANTHROPIC_API_KEY"] as const;

/** Spent at or past this share of the budget: the key is near it (Activity and its row say so). */
export const BUDGET_NEAR = 0.8;

/** The words in every refusal for a spent budget: work parked by one is queued again when a budget changes and on the 1st. */
export const BUDGET_STOP = "monthly budget of $";

export interface ServiceUsageView {
  lines: ServiceUsageLine[];
  limits: ServiceLimit[];
  /** each key the person has (and for an admin the server's) that can take a budget */
  budgets: KeyBudget[];
}
