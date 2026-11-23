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
  limit?: number;
  unit: string;
  /** ms */
  resetsAt?: number;
  /** when it was read, ms */
  at: number;
}

export interface ServiceUsageView {
  lines: ServiceUsageLine[];
  limits: ServiceLimit[];
}
