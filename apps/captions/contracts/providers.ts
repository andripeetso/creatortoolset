/**
 * AI providers: a provider is one coding-agent CLI on a Mac, signed in as one identity. Anthropic runs through
 * the Claude CLI, so the server's own Claude sign-in serves it. An Anthropic API key is not a provider (see below).
 *
 * A provider instance is one coding-agent CLI (its driver) signed in as one identity (its home folder, e.g.
 * ~/.claude-work, which sends Claude through the signed-in Claude account), run by a paired Mac (the Mac relay).
 * Every job picks an instance, a model and an effort. An Anthropic API key is not a provider: it answers an account
 * with no provider: its own key from Settings → My API keys (api/my-keys.ts keyFor).
 */

export type Driver = "claude" | "codex" | "cursor" | "grok" | "gemini" | "opencode" | "antigravity" | "muse" | "pi";

/** The drivers, in the order the settings page lists them. `runs`: a paired Mac can run it today (the others are listed, not run yet). */
export const DRIVERS: ReadonlyArray<{ id: Driver; label: string; runs: boolean; homeEnv?: string }> = [
  { id: "codex", label: "Codex", runs: true, homeEnv: "CODEX_HOME" },
  { id: "claude", label: "Claude", runs: true, homeEnv: "CLAUDE_CONFIG_DIR" },
  { id: "cursor", label: "Cursor", runs: false },
  { id: "grok", label: "Grok", runs: true },
  { id: "gemini", label: "Gemini", runs: true, homeEnv: "GEMINI_CLI_HOME" },
  { id: "opencode", label: "OpenCode", runs: false },
  { id: "antigravity", label: "Antigravity", runs: false },
  { id: "muse", label: "Muse Code", runs: false },
  { id: "pi", label: "Pi", runs: false },
];

/** The drivers the Creator Toolset Mac app runs (apps/mac ClaudeRequest.swift `runnableDrivers`). */
const APP_DRIVERS: ReadonlyArray<Driver> = ["claude", "gemini"];

/** Whether a paired Mac can run a driver: the settings offer only these. */
export const runsOn = (driver: Driver): boolean => !!DRIVERS.find((d) => d.id === driver)?.runs && APP_DRIVERS.includes(driver);

/** A driver's name as people say the tool: "Claude Code", not the short label. */
export const TOOL_NAMES: Partial<Record<Driver, string>> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

export interface ProviderInstance {
  /** "claude_work", "codex"… stable: jobs point at it */
  id: string;
  driver: Driver;
  /** "Claude (work)" */
  name: string;
  enabled: boolean;
  /** the identity: the CLI's config folder on the Mac (CLAUDE_CONFIG_DIR / CODEX_HOME); empty = the CLI's default */
  home?: string;
  /** the paired Mac that runs it (a provider belongs to one device); missing = none picked, so it runs nowhere */
  device?: string;
  /** the last check that ran on it (written by the check, kept across restarts); setup's "Connected" is this passing */
  lastCheck?: { ok: boolean; at: number; ms: number };
}

export interface Selection {
  instance: string;
  model: string;
  effort: Effort;
}

/** What a job is, for its default and the usage page. Every AI call names one. */
export const JOBS = [
  { id: "workshop", label: "Content Workshop" },
  { id: "captions", label: "Caption Studio" },
  { id: "analyzer", label: "Content Analyzer" },
  { id: "notes", label: "Video Notes and guides" },
  { id: "editor", label: "AI Editor" },
] as const;
export type JobId = (typeof JOBS)[number]["id"];

/**
 * One set of providers. The workspace's (the admins', $DATA_DIR/ai-providers.json) answers admins and background
 * work, never anyone else; anyone may keep their own ($DATA_DIR/ai-providers/<user>.json), which answers them first.
 */
export interface ProviderSettings {
  instances: ProviderInstance[];
  /** every job without its own pick */
  default: Selection;
  jobs: Partial<Record<JobId, Selection>>;
}

/**
 * A Mac that runs AI jobs. Any account can add its own Mac by signing in to the Creator Toolset Mac app, which pairs it
 * (POST /api/devices, cookie) and then answers its jobs with a device token (Authorization: Bearer ctd_…).
 */
export interface Device {
  id: string;
  /** who it belongs to: the account that paired it */
  owner: string;
  name: string;
  createdAt: number;
  /** its last poll or post (ms); online = within 40 s */
  lastSeen?: number;
  /** the Mac app's version */
  version?: string;
  /** what it reported last: CLIs and config folders */
  report?: MacReport;
}

/** What the Mac app found on the Mac (the Mac relay `report`, hourly and at start). */
export interface MacReport {
  at: number;
  /** `signedIn` and `plan`: what the CLI itself says (`claude auth status --json`: its subscriptionType and planTier; `codex login status`), never read from its files */
  drivers: Array<{ driver: Driver; installed: boolean; version?: string; path?: string; signedIn?: boolean; plan?: string }>;
  /** config folders found for a driver, e.g. ~/.claude-work */
  homes: Array<{ driver: Driver; home: string }>;
  /** the computer itself: what it is and how busy it was when it reported */
  machine?: Machine;
}

/** A computer's hardware and load (its report). */
export interface Machine {
  os?: "mac" | "linux" | "windows";
  host?: string;
  /** the CPU or chip, e.g. "Apple M2 Max" */
  cpu?: string;
  cpus: number;
  /** how busy the CPU is, 0..1 (the last minute's load over the cores) */
  load?: number;
  memGb: number;
  freeGb?: number;
  gpu?: string;
  gpuMemGb?: number;
  gpuFreeGb?: number;
}

/** A Machine from an untrusted body, or undefined. */
export function parseMachine(v: unknown): Machine | undefined {
  const o = v as Record<string, unknown> | null;
  const num = (x: unknown, max: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= max ? x : undefined);
  const text = (x: unknown) => (typeof x === "string" && x.trim() ? x.trim().slice(0, 80) : undefined);
  const cpus = num(o?.cpus, 4096);
  const memGb = num(o?.memGb, 65536);
  if (!o || typeof o !== "object" || !cpus || !memGb) return undefined;
  const os = o.os === "mac" || o.os === "linux" || o.os === "windows" ? o.os : undefined;
  const m: Machine = { cpus: Math.round(cpus), memGb };
  const extra: Partial<Machine> = { os, host: text(o.host), cpu: text(o.cpu), load: num(o.load, 1), freeGb: num(o.freeGb, memGb),
    gpu: text(o.gpu), gpuMemGb: num(o.gpuMemGb, 65536), gpuFreeGb: num(o.gpuFreeGb, 65536) };
  for (const [k, x] of Object.entries(extra)) if (x !== undefined) (m as unknown as Record<string, unknown>)[k] = x;
  return m;
}

/** A provider's check (POST /api/providers/:id/check): a one-line prompt through the Mac. */
export interface ProviderCheck {
  ok: boolean;
  ms: number;
  model?: string;
  text?: string;
  error?: string;
  at: number;
}

/** One plan limit window of a signed-in identity: how much of it is used, and when it resets. */
export interface LimitWindow {
  /** "five_hour", "seven_day", "primary"… as the provider names it */
  id: string;
  /** what the window is: "Session", "Weekly", "Weekly · Opus", "Monthly" */
  label: string;
  /** its length class: a session (hours), a week, or a month; "other" when the provider gives no length */
  kind: "session" | "weekly" | "monthly" | "other";
  usedPercent: number;
  /** epoch ms; missing when the provider didn't say */
  resetsAt?: number;
  /** the window's length in ms */
  windowMs?: number;
}

/**
 * A signed-in identity's plan limits (a Claude or Codex config folder), as its Mac read them every five minutes
 * (the Mac app's Limits.swift). Never a token. `instances` = the `${scope}:${id}` provider keys that run on it.
 */
export interface LimitsIdentity {
  driver: Driver;
  /** the folder's name without its dot prefix ("work"; "default" for ~/.claude, ~/.codex) */
  label: string;
  /** ok; no_login = no sign-in in that folder; signed_out = sign in again there; error = could not read it */
  state: "ok" | "no_login" | "signed_out" | "error";
  error?: string;
  windows: LimitWindow[];
  /** when the server got the reading (ms) */
  at: number;
  device: string;
  online: boolean;
  instances: string[];
}

/** Models offered per driver (the Claude CLI on the user's Mac runs every one). */
export const DRIVER_MODELS: Partial<Record<Driver, string[]>> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
  // the current GA flash and lite models, and the pro one that is still preview-only
  gemini: ["gemini-3.8-flash", "gemini-3.5-flash-lite", "gemini-3.1-pro-preview"],
};

/** Nothing is added, connected or signed in before a person presses Connect (setup, api/lib/local-ai.ts). */
export const DEFAULT_SETTINGS: ProviderSettings = {
  instances: [],
  default: { instance: "", model: "", effort: "xhigh" },
  jobs: {},
};

/** Whose providers a set is: the workspace's, or one account's own. Instance ids are unique within a scope. */
export type Scope = "workspace" | string;

/**
 * GET /api/providers (any account): everything the Settings page shows.
 *   PUT /api/providers/workspace   (admins) body ProviderSettings → ProviderSettings
 *   PUT /api/providers/own         body ProviderSettings | null (null = drop my own, use the workspace's) → ProvidersView
 *   POST /api/providers/:scope/:id/check → ProviderCheck (a one-line prompt on the instance's device; admins any scope, others their own)
 * Devices (cookie):
 *   POST /api/devices body { name, version? } → { device: Device, token: "ctd_…" } (the token is shown once; the Mac app keeps it)
 *   GET /api/devices → Array<Device & { online: boolean }>; PATCH /api/devices/:id { name }; DELETE /api/devices/:id (revoke)
 * A device's jobs (Authorization: Bearer ctd_…):
 *   POST /api/devices/relay/wait | /report | /:id/text | /:id/step | /:id/done | /:id/fail
 *   A device is handed only requests whose provider runs on it (provider.device === its id).
 */
export interface ProvidersView {
  /** admins: editable; other accounts: shown (read-only) while an admin shares them with it, else null */
  workspace: { settings: ProviderSettings; editable: boolean } | null;
  /** this account's own providers (null = none yet) */
  own: ProviderSettings | null;
  /** what answers this account's jobs now */
  using: "own" | "workspace" | "none";
  /** this account's devices; admins also the workspace's (admins' Macs) */
  devices: Array<Device & { online: boolean }>;
  /** by `${scope}:${instanceId}` */
  checks: Record<string, ProviderCheck>;
  models: Record<string, string[]>;
  /** this account's usage (admins: the workspace's too), 90 days by hour (UTC) */
  usage: Array<{ hour: string; label: string; scope: Scope; instance?: string; calls: number; tokens: number; costUsd: number }>;
  /** the plan limits of the identities this account's visible providers run on (never another person's) */
  limits: LimitsIdentity[];
}
