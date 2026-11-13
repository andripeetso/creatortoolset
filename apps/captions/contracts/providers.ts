/**
 * AI providers: a provider is one coding-agent CLI on a Mac, signed in as one identity. Anthropic runs through
 * the Claude CLI, so the server's own Claude sign-in serves it. An Anthropic API key is not a provider (see below).
 *
 * A provider instance is one coding-agent CLI (its driver) signed in as one identity (its home folder, e.g.
 * ~/.claude-work, which sends Claude through the signed-in Claude account), run by a paired Mac (the Mac relay).
 * Every job picks an instance, a model and an effort. An Anthropic API key is not a provider: it answers an account
 * with no provider: its own key from Settings → API keys (api/my-keys.ts keyFor).
 */

import type { PlanId } from "./plans";
import type { Disk } from "./storage";

export type BuiltinDriver = "claude" | "codex" | "cursor" | "grok" | "gemini" | "opencode" | "antigravity" | "musecode" | "pi" | "acp";

/** A driver id: a built-in driver, or a driver kind a plug-in adds (DriverKind, below). */
export type Driver = BuiltinDriver | string;

/**
 * A driver kind a plug-in adds (plugin.ts `providers.kinds`). It is listed in the Add provider grid, but it runs no job
 * until the Creator Toolset Mac app can run its CLI, which none does yet.
 */
export interface DriverKind {
  id: string;
  label: string;
  featured: boolean;
}

/**
 * A ready provider a plug-in adds (plugin.ts `providers.presets`): the Add provider grid shows it as a row with its badge,
 * and picking it fills in the driver, folder and name. `baseUrl` is the endpoint the CLI sends to: the server reads it
 * from the preset and never sends it to the page or saves it with the instance.
 */
export interface ProviderPreset {
  id: string;
  name: string;
  driver: Driver;
  badge: string;
  home?: string;
  baseUrl?: string;
}

/** A preset as the page sees it (no endpoint). */
export type PresetView = Omit<ProviderPreset, "baseUrl">;

/**
 * The drivers, in the order the Add provider wizard lists them: `featured` ones up front, the rest under "Show more".
 * `runs`: the driver's CLI can run on a paired Mac at all (the Mac app's own list, APP_DRIVERS, decides what runs today).
 */
export const DRIVERS: ReadonlyArray<{ id: Driver; label: string; runs: boolean; featured: boolean; homeEnv?: string }> = [
  { id: "codex", label: "Codex", runs: true, featured: true, homeEnv: "CODEX_HOME" },
  { id: "claude", label: "Claude", runs: true, featured: true, homeEnv: "CLAUDE_CONFIG_DIR" },
  { id: "cursor", label: "Cursor", runs: true, featured: true },
  { id: "grok", label: "Grok", runs: true, featured: true },
  { id: "opencode", label: "OpenCode", runs: true, featured: true },
  { id: "antigravity", label: "Antigravity", runs: true, featured: true },
  { id: "musecode", label: "Muse Code", runs: true, featured: true },
  { id: "pi", label: "Pi", runs: true, featured: true },
  { id: "gemini", label: "Gemini", runs: true, featured: false, homeEnv: "GEMINI_CLI_HOME" },
  { id: "acp", label: "Local ACP command", runs: true, featured: false },
];

/** The drivers the Creator Toolset Mac app runs (apps/mac ClaudeRequest.swift `runnableDrivers`). */
const APP_DRIVERS: ReadonlyArray<Driver> = ["claude", "gemini", "codex", "grok", "musecode", "cursor", "opencode", "antigravity", "pi", "acp"];

/** The drivers the Mac runs as an Agent Client Protocol agent over stdio (apps/mac ClaudeRun.swift `acpAnswer`). */
export const isAcpDriver = (driver: Driver): boolean => ["cursor", "opencode", "antigravity", "pi", "acp"].includes(driver);

/** Whether a paired Mac can run a driver: the settings offer only these. */
export const runsOn = (driver: Driver): boolean => !!DRIVERS.find((d) => d.id === driver)?.runs && APP_DRIVERS.includes(driver);

/**
 * Launch arguments are kept only for the ACP kinds. The other drivers' CLIs take none from settings, so the page
 * hides the field and the server drops any sent for them.
 */
export const launchArgsAllowed = (driver: Driver): boolean => isAcpDriver(driver);

/**
 * The Advanced fields a driver's settings page shows: each only where the Mac reads it (apps/mac ClaudeRequest.swift).
 * The server keeps only these for the driver (parseSettings), so a row with no reader is never saved.
 */
export const driverFields = (driver: Driver): { home: boolean; program: boolean; args: boolean; env: boolean } => ({
  /** the config folder: CLAUDE_CONFIG_DIR, CODEX_HOME, GEMINI_CLI_HOME */
  home: !!DRIVERS.find((d) => d.id === driver)?.homeEnv,
  /** the program's full path, and the arguments: only the ACP kinds start a program from settings */
  program: isAcpDriver(driver),
  args: launchArgsAllowed(driver),
  /** variable names: the Mac passes them to Claude and the ACP kinds only */
  env: driver === "claude" || isAcpDriver(driver),
});

/** A driver's name as people say the tool: "Claude Code", not the short label. */
export const TOOL_NAMES: Partial<Record<Driver, string>> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI", grok: "Grok" };

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
  /** the CLI's executable on the Mac, an absolute path; missing = the driver's usual name on the Mac's PATH */
  binaryPath?: string;
  /** extra arguments for the CLI, one literal argument per item, in launch order (ACP kinds only, see driverFields) */
  launchArgs?: string[];
  /** names of environment variables passed to the CLI; their values stay on the Mac, never here (see driverFields) */
  envNames?: string[];
  /** this provider's model and thinking level: used when it is picked with no model of its own (see addInstanceTo) */
  model?: string;
  effort?: Effort;
  /** driver "acp": the command that starts the ACP agent on the Mac (the other ACP kinds start their own default command) */
  acp?: AcpCommand;
  /** the API endpoint the CLI sends its requests to (ANTHROPIC_BASE_URL). Only a plug-in's own instance sets it; the settings page never does, and parseSettings drops it. */
  baseUrl?: string;
  /** the plug-in preset it was added from; its endpoint comes from that preset on the server, never from this file */
  preset?: string;
  /** the last check that ran on it (written by the check, kept across restarts); setup's "Connected" is this passing */
  lastCheck?: { ok: boolean; at: number; ms: number; note?: string };
}

/** A command the Mac starts to run an ACP agent over stdio, and its arguments. */
export interface AcpCommand {
  command: string;
  args: string[];
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
  /** the editor step kinds it runs (contracts/devices.ts); it is handed only these */
  kinds?: string[];
  /**
   * Speech models (contracts/voice.ts STT_MODELS ids) on a computer that declares TRANSCRIBE_KIND: what its owner asked it
   * to keep (Download), and what it said it has and is downloading (its last claim; `claimed`: it has claimed since).
   */
  /** `ready`: the models a Mac has loaded now, so it can hear a recording someone waits on at once (the mic); absent:
   * not said (another computer, or an older Mac app) */
  stt?: { want: string[]; held: string[]; getting: string[]; claimed?: true; ready?: string[] };
}

/** What the Mac app found on the Mac (the Mac relay `report`, hourly and at start). */
export interface MacReport {
  at: number;
  /** `signedIn` and `plan`: what the CLI itself says (`claude auth status --json`: its subscriptionType and planTier; `codex login status`), never read from its files */
  drivers: Array<{ driver: Driver; installed: boolean; version?: string; path?: string; signedIn?: boolean; plan?: string }>;
  /** config folders found for a driver, e.g. ~/.claude-work */
  homes: Array<{
    driver: Driver;
    home: string;
    /** a Claude folder whose settings.json sets a custom API endpoint (ANTHROPIC_BASE_URL); only the yes or no is sent, never the URL or token */
    customEndpoint?: boolean;
  }>;
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
  /** the disks it keeps files on: its system disk, external drives, network shares (with the machine they live on) */
  disks?: Disk[];
}

/**
 * Load balancing for the AI Editor's device jobs (Settings → Devices): on, and each computer's weight by device id.
 * A job goes to the free computer with the best weight × cores × idle CPU × free memory share.
 */
export interface Balance {
  on: boolean;
  weights: Record<string, number>;
}
export const LOAD_PREFERENCES = [
  { value: 100, label: "Prefer" },
  { value: 50, label: "Normal" },
  { value: 25, label: "Less often" },
  { value: 0, label: "Off" },
] as const;
export const DEFAULT_WEIGHT = 50;

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
  const disks = (Array.isArray(o.disks) ? o.disks : []).slice(0, 24).flatMap((v: unknown): Disk[] => {
    const d = v as Record<string, unknown> | null;
    const path = typeof d?.path === "string" ? d.path.slice(0, 300) : "";
    const name = text(d?.name);
    const freeGb = num(d?.freeGb, 1e7);
    if (!path || !name || freeGb === undefined) return [];
    const out: Disk = { path, name, freeGb };
    const totalGb = num(d?.totalGb, 1e7);
    if (totalGb !== undefined) out.totalGb = totalGb;
    if (d?.network === true) out.network = true;
    const server = text(d?.server);
    if (server) out.server = server;
    return [out];
  });
  if (disks.length) m.disks = disks;
  return m;
}

/** A provider's check (POST /api/providers/:id/check): a one-line prompt through the Mac. */
export interface ProviderCheck {
  ok: boolean;
  ms: number;
  model?: string;
  text?: string;
  error?: string;
  /** on a passing check: what the person should know although it works ("Weekly limit reached, resets Friday 09:00") */
  note?: string;
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
  /** the plan the usage page names, when it is one PLANS has (Codex's plan_type, contracts/plans.ts codexPlan) */
  plan?: PlanId;
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
  // fallback for Codex: the models a ChatGPT login listed in codex-cli 0.39. On the owner's Mac the server reads the
  // login's own list (api/lib/providers.ts codexLoginModels), so this only answers where Codex's cache can't be read.
  codex: ["gpt-6-luna", "gpt-5.6-terra", "gpt-5.6-luna"],
};

/** Nothing is added, connected or signed in before a person presses Connect (setup, api/lib/local-ai.ts). */
export const DEFAULT_SETTINGS: ProviderSettings = {
  instances: [],
  default: { instance: "", model: "", effort: "xhigh" },
  jobs: {},
};

/**
 * Adds a provider to a set (replacing one with the same id), and makes it the Default when the set has none. The one
 * way a provider gets written: the Settings page and setup's Connect both build the set here, and the server checks it
 * (parseSettings) before it saves.
 */
export function addInstanceTo(set: ProviderSettings | null, inst: ProviderInstance): ProviderSettings {
  const cur = set ?? structuredClone(DEFAULT_SETTINGS);
  const instances = cur.instances.some((i) => i.id === inst.id) ? cur.instances.map((i) => (i.id === inst.id ? inst : i)) : [...cur.instances, inst];
  const def: Selection = cur.default.instance
    ? cur.default
    : { instance: inst.id, model: inst.model ?? DRIVER_MODELS[inst.driver]?.[0] ?? "", effort: inst.effort ?? "xhigh" };
  return { ...cur, instances, default: def };
}

/** Whose providers a set is: the workspace's, or one account's own. Instance ids are unique within a scope. */
export type Scope = "workspace" | string;

/**
 * GET /api/providers (any account): everything the Settings page shows.
 *   GET /api/providers/drivers     → DriverCatalog (any account; each driver per Mac it can see)
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
  /**
   * A member on the team's API budget (hosted): the team's AI answers their jobs when they have no AI of their own that
   * can run. Only this account's own numbers. Absent for everyone else.
   */
  teamAi?: { budgetUsd: number; spentUsd: number; left: number; ready: boolean } | null;
}

/** One Mac's word on one driver: what its last report found (`signedIn` absent = the CLI doesn't say). */
export interface DriverDevice {
  device: string;
  name: string;
  online: boolean;
  installed: boolean;
  signedIn?: boolean;
  version?: string;
}

/** One driver in the Add provider wizard: whether it is featured, whether a paired Mac runs it, why not, and per Mac what it found. */
export interface DriverEntry {
  id: Driver;
  label: string;
  featured: boolean;
  runs: boolean;
  /** why it is shown disabled (absent when it runs) */
  reason?: string;
  /** the Macs that have reported (a Mac that never reported is left out, not shown as "not installed") */
  devices: DriverDevice[];
}

/** GET /api/providers/drivers → the driver catalog: the built-in drivers in DRIVERS order, then any plug-in driver kinds; and the plug-in presets. */
export interface DriverCatalog {
  drivers: DriverEntry[];
  presets?: PresetView[];
}
