/**
 * AI providers: a provider is one coding-agent CLI on a Mac, signed in as one identity. Anthropic runs through
 * the Claude CLI, so the server's own Claude sign-in serves it. An Anthropic API key is not a provider (see below).
 *
 * A provider instance is one coding-agent CLI (its driver) signed in as one identity (its home folder, e.g.
 * ~/.claude-work, which sends Claude through the signed-in Claude account), run by a paired Mac (the Mac relay).
 * Every job picks an instance, a model and an effort. An Anthropic API key is not a provider: it answers an account
 * with no provider: its own key from Settings → My API keys (api/my-keys.ts keyFor).
 */

export type Driver = "claude" | "codex" | "cursor" | "grok" | "opencode" | "antigravity" | "muse" | "pi";

/** The drivers, in the order the settings page lists them. `runs`: a paired Mac can run it today (the others are listed, not run yet). */
export const DRIVERS: ReadonlyArray<{ id: Driver; label: string; runs: boolean; homeEnv?: string }> = [
  { id: "codex", label: "Codex", runs: true, homeEnv: "CODEX_HOME" },
  { id: "claude", label: "Claude", runs: true, homeEnv: "CLAUDE_CONFIG_DIR" },
  { id: "cursor", label: "Cursor", runs: false },
  { id: "grok", label: "Grok", runs: true },
  { id: "opencode", label: "OpenCode", runs: false },
  { id: "antigravity", label: "Antigravity", runs: false },
  { id: "muse", label: "Muse Code", runs: false },
  { id: "pi", label: "Pi", runs: false },
];

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
}

export interface Selection {
  instance: string;
  model: string;
  effort: Effort;
}

/** What a job is, for its default and the usage page. Every AI call names one. */
export const JOBS = [
  { id: "workshop", label: "Content Workshop", hint: "turns, line options, side chat, drafts, accuracy checks" },
  { id: "captions", label: "Caption Studio", hint: "caption lines, polish, script check" },
  { id: "analyzer", label: "Content Analyzer", hint: "reading posts and slides, tags, the Idea board" },
  { id: "notes", label: "Video Notes and guides", hint: "summaries, chapters, Guide Builder, Documents" },
  { id: "editor", label: "AI Editor", hint: "lines and takes, B-roll picks, revisions" },
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

/** Models offered per driver (the Claude CLI on the user's Mac runs every one). */
export const DRIVER_MODELS: Partial<Record<Driver, string[]>> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"],
};

export const DEFAULT_SETTINGS: ProviderSettings = {
  instances: [{ id: "claude", driver: "claude", name: "Claude", enabled: true }],
  default: { instance: "claude", model: "claude-opus-5-5", effort: "xhigh" },
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
}
