import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type CliId, type ConnectResult, type LocalAiRow, type LocalAiView, type McpResult, type SignInResult } from "../../contracts/local-ai";
import { planFromCli, type PlanId } from "../../contracts/plans";
import { addInstanceTo, type ProviderInstance } from "../../contracts/providers";
import { checkInstance } from "../providers";
import { connectedOwn, modelsFor, ownSettings, parseSettings, saveSettings } from "./providers";
import { deviceOf, isOnline } from "./devices";
import { findUser, newApiKey, type UserRecord } from "../users";

/**
 * Setup's "Connect your AI" (Settings → Providers shares it): finds the AI command-line tools on this Mac, connects one
 * as this account's AI after a real check, and adds Creator Toolset to the ones the person chose. Runs only on the
 * owner's Mac (CT_LOCAL=1, the routes check it), and nothing here runs before a button is pressed.
 *
 * Binaries: a login shell's `command -v` first (nvm is set up in .zshrc, so -i), then fixed fallbacks. Every spawn puts
 * the binary's own folder first on PATH, since Claude Code is a Node script. Install and sign-in run the vendors' own
 * commands as child processes here (no Terminal window): see installCli and signIn.
 */

export const CLI_IDS: CliId[] = ["claude", "codex", "gemini"];
const NAMES: Record<CliId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini CLI" };
const DESKTOP: Array<{ id: "claude-desktop" | "chatgpt-desktop"; name: string; app: string }> = [
  { id: "claude-desktop", name: "Claude desktop", app: "Claude" },
  { id: "chatgpt-desktop", name: "ChatGPT desktop", app: "ChatGPT" },
];
/** The name this server goes by in the AI CLIs' MCP lists. */
export const MCP_NAME = "creator-toolset";
const MISSING = "Couldn't find it on this Mac anymore. Check it's still installed.";
export const MAC_ONLY = "Open the Creator Toolset Mac app to connect your AI.";
const PROBE_TTL = 10_000;

/* ---- running the tools ---- */

export interface Out {
  stdout: string;
  stderr: string;
  /** 0 on success; a number for a failed exit; "ENOENT" when the file is not there */
  code: number | string | null;
}
export type Runner = (file: string, args: string[], opt: { env?: NodeJS.ProcessEnv; timeout: number }) => Promise<Out>;

const execP = promisify(execFile);
const realRun: Runner = async (file, args, opt) => {
  try {
    const r = await execP(file, args, { env: opt.env, timeout: opt.timeout, maxBuffer: 4 << 20 });
    return { stdout: String(r.stdout), stderr: String(r.stderr), code: 0 };
  } catch (e) {
    const x = e as { stdout?: unknown; stderr?: unknown; code?: number | string; message?: string };
    return { stdout: String(x.stdout ?? ""), stderr: String(x.stderr ?? x.message ?? ""), code: x.code ?? null };
  }
};
let run: Runner = realRun;

const bins = new Map<CliId, string>();
let codexUrl: boolean | undefined;
const probes = new Map<CliId, { at: number; p: Probe }>();

/** Tests: a fake runner, and a clean cache. */
export function setRunnerForTests(r?: Runner): void {
  run = r ?? realRun;
  bins.clear();
  probes.clear();
  codexUrl = undefined;
}

/** Whether a desktop app is installed: the real /Applications on this Mac, unless a test says otherwise. */
let appPresent = (app: string): boolean => existsSync(`/Applications/${app}.app`);
export function setDesktopAppsForTests(f?: (app: string) => boolean): void {
  appPresent = f ?? ((app) => existsSync(`/Applications/${app}.app`));
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first candidate that exists and can run. Pure except for the check passed in. */
export function firstExecutable(candidates: string[], ok: (p: string) => boolean = isExecutable): string | null {
  return candidates.find(ok) ?? null;
}

/** The nvm Node versions' folders, newest first (their bin folders hold the CLIs nvm installed). */
export function nvmVersionDirs(home: string): string[] {
  const root = path.join(home, ".nvm", "versions", "node");
  try {
    return readdirSync(root)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((v) => path.join(root, v));
  } catch {
    return [];
  }
}

/** Where a CLI is installed when the login shell can't say: the usual places, in order. The server may have started with a short PATH (the Mac app's), so the common global install folders are listed too. */
export function fallbackCandidates(id: CliId, home: string, nvmDirs: string[]): string[] {
  return [
    `/opt/homebrew/bin/${id}`,
    `/usr/local/bin/${id}`,
    path.join(home, ".local", "bin", id),
    path.join(home, ".npm-global", "bin", id),
    path.join(home, ".volta", "bin", id),
    path.join(home, ".bun", "bin", id),
    ...nvmDirs.map((d) => path.join(d, "bin", id)),
    `/usr/bin/${id}`,
  ];
}

/** Forgets what was found about one CLI, so the next look reads the machine again (Check again after an install). */
export function forgetCli(id: CliId): void {
  bins.delete(id);
  probes.delete(id);
  if (id === "codex") codexUrl = undefined;
}

/** Where the managed Node.js is kept (installNode), and its bin folder. */
const nodeRoot = (): string => path.join(os.homedir(), "Library", "Application Support", "Creator Toolset", "node");
/** PATH for a spawn: the binary's own folder, the managed Node's (once this server installed it), then the rest. */
export const toolPath = (bin: string): string =>
  [path.dirname(bin), ...(existsSync(path.join(nodeRoot(), "bin")) ? [path.join(nodeRoot(), "bin")] : []), process.env.PATH ?? ""].join(":");

async function lookup(id: CliId): Promise<string | null> {
  // -i: nvm is usually set up in .zshrc, which only an interactive login shell reads
  const out = await run("/bin/zsh", ["-lic", `command -v ${id}`], { timeout: 5000 });
  const line = out.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")).pop();
  if (line) return line;
  return firstExecutable(fallbackCandidates(id, os.homedir(), nvmVersionDirs(os.homedir())));
}

/** The CLI's path on this Mac, cached once found. */
export async function binFor(id: CliId): Promise<string | null> {
  const hit = bins.get(id);
  if (hit) return hit;
  const found = await lookup(id);
  if (found) bins.set(id, found);
  return found;
}

/** Runs a CLI with its own folder first on PATH. A missing binary clears the cache once and looks again. */
async function runCli(id: CliId, args: string[], timeout: number, extraEnv: Record<string, string> = {}): Promise<Out | null> {
  for (let tries = 0; tries < 2; tries++) {
    const bin = await binFor(id);
    if (!bin) return null;
    const out = await run(bin, args, {
      timeout,
      env: { ...process.env, ...extraEnv, PATH: toolPath(bin) },
    });
    if (out.code !== "ENOENT") return out;
    bins.delete(id);
  }
  return null;
}

/* ---- reading what the tools say ---- */

/** `claude auth status --json`: signed in or not, and the plan when the CLI names one (its subscriptionType or planTier). */
export function parseClaudeAuth(text: string): { signedIn: boolean | null; plan?: PlanId } {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    return { signedIn: null };
  }
  if (!j || typeof j !== "object") return { signedIn: null };
  const o = j as Record<string, unknown>;
  if (typeof o.loggedIn !== "boolean") return { signedIn: null };
  const plan = planFromCli(`${typeof o.subscriptionType === "string" ? o.subscriptionType : ""} ${typeof o.planTier === "string" ? o.planTier : ""}`);
  return plan ? { signedIn: o.loggedIn, plan } : { signedIn: o.loggedIn };
}

/** `codex login status` says "Logged in using ChatGPT"; matching ignores case and never trusts "not logged in". */
export const parseCodexLogin = (text: string): boolean => /logged in/i.test(text) && !/not logged in/i.test(text);

/** The first line of `--version`, at most 120 characters. */
export const parseVersion = (text: string): string | undefined => text.split("\n")[0]?.trim().slice(0, 120) || undefined;

/** The raw text, as the message a person sees (plain words; the raw text stays for Details). */
export function plainError(raw: string): { state: "signin" | "missing" | "failed"; message: string } {
  if (/not logged in|\/login|log in|authentication|unauthorized|401/i.test(raw)) return { state: "signin", message: "Not signed in yet." };
  if (/timed out|timeout|did not pick up/i.test(raw)) return { state: "failed", message: "It took too long to answer. Try again." };
  if (/ENOENT|command not found|no such file/i.test(raw)) return { state: "missing", message: MISSING };
  return { state: "failed", message: "It didn't answer. Check that you're signed in, then try again." };
}

/** Homebrew installs update with brew; anything else with npm. */
export function codexUpdateCommand(bin: string, real = bin): string {
  return /\/Cellar\/|\/Caskroom\//.test(real) || bin.startsWith("/opt/homebrew/") ? "brew upgrade codex" : "npm install -g @openai/codex@latest";
}

/** The `~/.claude-*` folders that hold a Claude sign-in (existence only; the CLI reads its own files). */
export function claudeFolders(home: string): string[] {
  try {
    return readdirSync(home)
      .filter((n) => n.startsWith(".claude-"))
      .map((n) => path.join(home, n))
      .filter((d) => existsSync(path.join(d, "settings.json")) || existsSync(path.join(d, ".credentials.json")));
  } catch {
    return [];
  }
}

/* ---- probing ---- */

export interface Probe {
  id: CliId;
  found: boolean;
  version?: string;
  signedIn: boolean | null;
  plan?: PlanId;
  /** Claude: the signed-in config folder when the default one is not signed in */
  home?: string;
  /** Codex: `codex mcp add` takes --url */
  supportsUrl?: boolean;
  /** the binary's path and where it really lives (for the update command) */
  bin?: string;
  real?: string;
}

async function codexSupportsUrl(): Promise<boolean> {
  if (codexUrl === undefined) {
    const h = await runCli("codex", ["mcp", "add", "--help"], 3000);
    if (h) codexUrl = /--url/.test(h.stdout + h.stderr);
  }
  return codexUrl ?? false;
}

/** The state of one CLI on this Mac, read from the CLI itself. `home` is where Claude folders are looked for. */
export async function probeCli(id: CliId, home = os.homedir()): Promise<Probe> {
  const v = await runCli(id, ["--version"], 2000);
  // found only when --version exits 0: a timeout or a crash is not a found CLI (M-53)
  if (!v || v.code !== 0) return { id, found: false, signedIn: null };
  const version = parseVersion(v.stdout || v.stderr);
  const bin = bins.get(id);
  const base: Probe = { id, found: true, version, signedIn: null, bin, real: bin ? safeReal(bin) : undefined };
  if (id === "gemini") return base;
  if (id === "codex") {
    const ls = await runCli("codex", ["login", "status"], 5000);
    return { ...base, signedIn: ls ? parseCodexLogin(ls.stdout + "\n" + ls.stderr) : null, supportsUrl: await codexSupportsUrl() };
  }
  const st = await runCli("claude", ["auth", "status", "--json"], 5000);
  let s = parseClaudeAuth(st?.stdout ?? "");
  let folder: string | undefined;
  if (s.signedIn === false) {
    for (const dir of claudeFolders(home)) {
      const o = await runCli("claude", ["auth", "status", "--json"], 5000, { CLAUDE_CONFIG_DIR: dir });
      const t = parseClaudeAuth(o?.stdout ?? "");
      if (t.signedIn) {
        s = t;
        folder = dir;
        break;
      }
    }
  }
  return { ...base, signedIn: s.signedIn, plan: s.plan, home: folder };
}

const safeReal = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/** probeCli on this account's Mac, cached for ten seconds (a `fresh` read skips the cache). */
export async function probe(id: CliId, fresh = false, home = os.homedir()): Promise<Probe> {
  const hit = probes.get(id);
  if (!fresh && hit && Date.now() - hit.at < PROBE_TTL) return hit.p;
  const p = await probeCli(id, home);
  probes.set(id, { at: Date.now(), p });
  return p;
}

/* ---- the view ---- */

/** The rows setup shows: each CLI found on this Mac, then the desktop apps found (text only). */
export async function localAiView(username: string, mcpTo: CliId[], fresh = false): Promise<LocalAiView> {
  // fresh: Check again. Nothing cached is used, so a CLI installed a moment ago is found and its sign-in is read again.
  if (fresh) CLI_IDS.forEach(forgetCli);
  const probed = await Promise.all(CLI_IDS.map((id) => probe(id, fresh)));
  const own = ownSettings(username)?.instances ?? [];
  const rows: LocalAiRow[] = [];
  for (const p of probed) {
    // not installed: still a row (Providers offers Install); the Own AI page lists only the found ones
    if (!p.found) {
      rows.push({ id: p.id, name: NAMES[p.id], kind: "cli", found: false, signedIn: null, connected: false, mcp: "n/a" });
      continue;
    }
    const inst = own.find((i) => i.id === `local-${p.id}`);
    const lastCheck = inst?.lastCheck;
    const mcp: LocalAiRow["mcp"] = p.id === "gemini" ? "n/a" : p.id === "codex" && !p.supportsUrl ? "update" : mcpTo.includes(p.id) ? "added" : "off";
    rows.push({
      id: p.id,
      name: NAMES[p.id],
      kind: "cli",
      found: true,
      version: p.version,
      signedIn: p.signedIn,
      ...(p.plan ? { plan: p.plan } : {}),
      connected: !!(inst?.enabled && lastCheck?.ok),
      ...(lastCheck ? { lastCheck } : {}),
      mcp,
      ...(mcp === "update" ? { updateCommand: codexUpdateCommand(p.bin ?? "", p.real) } : {}),
    });
  }
  for (const d of DESKTOP) {
    if (appPresent(d.app)) rows.push({ id: d.id, name: d.name, kind: "desktop", found: true, signedIn: null, connected: false, mcp: "n/a" });
  }
  return { local: true, rows };
}

/* ---- install: the vendors' own routes, run here as child processes (no Terminal) ---- */

/** Node.js for Gemini CLI's npm route, pinned: a newer Node is a deliberate change here, checked against its SHASUMS. */
export const NODE_VERSION = "22.18.0";
const STEP_MS = 5 * 60_000;
const LOGIN_MS = 5 * 60_000;
const localBin = (): string => path.join(os.homedir(), ".local", "bin");
const tailOf = (o: Out): string => (o.stderr || o.stdout || "").trim().slice(-600);
const envWith = (...dirs: string[]): NodeJS.ProcessEnv => ({ ...process.env, PATH: [...dirs, process.env.PATH ?? ""].join(":") });

/** A failed install step: one plain sentence for the person, the raw output for Details. */
interface Failed {
  message: string;
  raw?: string;
}

async function step(file: string, args: string[], env: NodeJS.ProcessEnv, message: string): Promise<Failed | null> {
  const out = await run(file, args, { env, timeout: STEP_MS });
  return out.code === 0 ? null : { message, raw: tailOf(out) };
}

/**
 * Claude Code: Anthropic's own installer (claude.ai/install.sh), which puts the native binary in ~/.local/bin. Needs no
 * Node and no Homebrew.
 */
async function installClaude(): Promise<Failed | null> {
  return step("/bin/bash", ["-o", "pipefail", "-c", "curl -fsSL https://claude.ai/install.sh | bash"], envWith(localBin()), `Couldn't install ${NAMES.claude}. Check the internet connection, then try again.`);
}

/**
 * Codex: OpenAI's release binary from GitHub (one file inside a .tar.gz), copied to ~/.local/bin. Needs no Node and no
 * Homebrew. Verified after by its absolute path (installCli).
 */
async function installCodex(): Promise<Failed | null> {
  const triple = os.arch() === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
  const dir = mkdtempSync(path.join(os.tmpdir(), "codex-install-"));
  try {
    const tgz = path.join(dir, "codex.tar.gz");
    const url = `https://github.com/openai/codex/releases/latest/download/codex-${triple}.tar.gz`;
    const failed =
      (await step("/usr/bin/curl", ["-fL", "--retry", "2", "-o", tgz, url], process.env, `Couldn't download ${NAMES.codex}. Check the internet connection, then try again.`)) ??
      (await step("/usr/bin/tar", ["-xzf", tgz, "-C", dir], process.env, `Couldn't unpack ${NAMES.codex}. Try again.`));
    if (failed) return failed;
    mkdirSync(localBin(), { recursive: true });
    const target = path.join(localBin(), "codex");
    copyFileSync(path.join(dir, `codex-${triple}`), target);
    chmodSync(target, 0o755);
    return null;
  } catch (e) {
    return { message: `Couldn't install ${NAMES.codex}. Try again.`, raw: errText(e) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Node.js for the npm route: the pinned release from nodejs.org, checked against its SHASUMS256 file, kept under nodeRoot(). */
async function installNode(): Promise<Failed | null> {
  const file = `node-v${NODE_VERSION}-darwin-${os.arch() === "arm64" ? "arm64" : "x64"}.tar.gz`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const dir = mkdtempSync(path.join(os.tmpdir(), "node-install-"));
  try {
    const tgz = path.join(dir, file);
    const sums = path.join(dir, "SHASUMS256.txt");
    const dl = "Couldn't download Node.js. Check the internet connection, then try again.";
    const failed = (await step("/usr/bin/curl", ["-fL", "--retry", "2", "-o", tgz, `${base}/${file}`], process.env, dl)) ?? (await step("/usr/bin/curl", ["-fL", "-o", sums, `${base}/SHASUMS256.txt`], process.env, dl));
    if (failed) return failed;
    const want = readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
    const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
    if (!want || want !== got) return { message: "The Node.js download didn't check out, so it wasn't used. Try again.", raw: `expected ${want ?? "no checksum"}, got ${got}` };
    mkdirSync(nodeRoot(), { recursive: true });
    return step("/usr/bin/tar", ["-xzf", tgz, "-C", nodeRoot(), "--strip-components", "1"], process.env, "Couldn't unpack Node.js. Try again.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Gemini CLI: npm, from the managed Node.js when this Mac has none (npm itself needs Node). */
async function installGemini(): Promise<Failed | null> {
  if (!existsSync(path.join(nodeRoot(), "bin", "node"))) {
    const node = await installNode();
    if (node) return node;
  }
  return step(
    path.join(nodeRoot(), "bin", "npm"),
    ["install", "-g", "--prefix", path.join(os.homedir(), ".local"), "@google/gemini-cli"],
    envWith(path.join(nodeRoot(), "bin"), localBin()),
    `Couldn't install ${NAMES.gemini}. Check the internet connection, then try again.`,
  );
}

/**
 * Installs one CLI by its vendor's own route, then runs the binary by its absolute path with --version: only a binary
 * that answers counts as installed. Nothing is shown as a command to paste.
 */
export async function installCli(id: CliId): Promise<SignInResult> {
  const failed = id === "claude" ? await installClaude() : id === "codex" ? await installCodex() : await installGemini();
  if (failed) return { ok: false, message: failed.message, raw: failed.raw };
  const bin = path.join(localBin(), id);
  const v = await run(bin, ["--version"], { env: { ...process.env, PATH: toolPath(bin) }, timeout: 15_000 });
  forgetCli(id); // the next look reads the machine again
  if (v.code !== 0) return { ok: false, message: `${NAMES[id]} installed, but it didn't start. Try again.`, raw: tailOf(v) };
  return { ok: true, message: `${NAMES[id]} is installed.` };
}

/* ---- sign in: the vendor's own sign-in runs as a child process; the page polls until it is done ---- */

/** The sign-in commands running now, one per CLI: a new press ends the older one. */
const logins = new Map<CliId, ChildProcess>();

/**
 * Starts the vendor's sign-in (its browser opens) as a child process. The page checks the sign-in every few seconds
 * until it is done. Gemini CLI signs in from its own screen.
 */
export async function signIn(id: CliId): Promise<SignInResult> {
  if (id === "gemini") return { ok: false, message: "Gemini CLI signs in on its own. Sign in there, then press Check." };
  const bin = await binFor(id);
  if (!bin) return { ok: false, message: MISSING };
  logins.get(id)?.kill();
  const child = spawn(bin, id === "claude" ? ["auth", "login"] : ["login"], { env: { ...process.env, PATH: toolPath(bin) }, stdio: ["ignore", "pipe", "pipe"] });
  logins.set(id, child);
  const started = await new Promise<boolean>((resolve) => {
    child.once("spawn", () => resolve(true));
    child.on("error", () => resolve(false)); // kept listened to: a late error must not crash the server
  });
  if (!started) {
    logins.delete(id);
    return { ok: false, message: `Couldn't start ${NAMES[id]} sign-in. Try again.` };
  }
  child.stdout?.resume();
  child.stderr?.resume();
  const timer = setTimeout(() => child.kill(), LOGIN_MS);
  child.on("exit", () => {
    clearTimeout(timer);
    if (logins.get(id) === child) logins.delete(id);
  });
  return { ok: true, message: "Your browser opens. Sign in there, then come back here." };
}

/* ---- connect ---- */

/**
 * Connects one CLI as this account's AI: its sign-in is checked (a signed-in folder is used when the default one is
 * signed out), a real check runs through `mac` (this server's own Mac, the device the Mac app paired here), and only a
 * passing check saves the instance. The first AI that connects becomes the default; a later one never takes it over
 * (the AI step's picker does that). Mints no key.
 */
export async function connectCli(username: string, id: CliId, home = os.homedir(), mac?: string): Promise<ConnectResult> {
  const p = await probe(id, true, home);
  if (!p.found) return { state: "missing", signedIn: null, answered: null, message: MISSING };
  if (p.signedIn === false) return { state: "signin", signedIn: false, answered: null, message: "Not signed in yet." };
  // this server's own Mac: a device of this account that is answering now, never the first online one of its Macs
  const device = mac ? deviceOf(mac) : undefined;
  if (!device || device.owner !== username || !isOnline(device.id)) return { state: "mac", signedIn: p.signedIn, answered: null, message: MAC_ONLY };

  const instId = `local-${id}`;
  const inst: ProviderInstance = { id: instId, driver: id, name: NAMES[id], enabled: true, device: device.id, ...(p.home ? { home: p.home } : {}) };
  // the same writer as the Settings page's Add provider: addInstanceTo builds the set, parseSettings checks it.
  // A first AI becomes the default with the first model this login really has (modelsFor), not the catalogue's.
  const cur = ownSettings(username);
  const built = addInstanceTo(cur, inst);
  const first = modelsFor(inst)[0];
  const next = parseSettings(!cur?.default.instance && first ? { ...built, default: { ...built.default, model: first } } : built, username, { trustedFolder: true });

  // the check runs before anything is saved: a failed check leaves the saved set, its default included, as it was
  const check = await checkInstance(username, inst, next);
  if (!check.ok) {
    const plain = plainError(check.error ?? "");
    if (plain.state === "signin") return { state: "signin", signedIn: false, answered: false, message: plain.message, raw: check.error };
    return { state: "failed", signedIn: p.signedIn, answered: false, ms: check.ms, message: plain.message, raw: check.error };
  }
  await saveSettings({ ...next, instances: next.instances.map((i) => (i.id === instId ? { ...i, lastCheck: { ok: true, at: check.at, ms: check.ms } } : i)) }, username);
  return { state: "ready", signedIn: p.signedIn, answered: true, ms: check.ms };
}

/* ---- Creator Toolset in each CLI ---- */

/** `claude mcp add` for this server on this Mac, for every project of the person's (user scope), as an argument list. */
export function claudeMcpAdd(port: number, key: string): string[] {
  return ["mcp", "add", "--transport", "http", "--scope", "user", MCP_NAME, `http://127.0.0.1:${port}/api/mcp`, "--header", `Authorization: Bearer ${key}`];
}

/** The same, typed into a terminal: each argument with a space in quotes. */
export const shellLine = (bin: string, args: string[]) =>
  [bin, ...args].map((a) => (/[^\w@%+=:,./-]/.test(a) ? `"${a}"` : a)).join(" ");

/** `codex mcp add` for this server: Codex 0.40+ takes an address; the key goes into its config (codexWithKey). */
export const codexMcpAdd = (port: number): string[] => ["mcp", "add", MCP_NAME, "--url", `http://127.0.0.1:${port}/api/mcp`];

/**
 * Codex's config.toml with the key header on this server's entry. `codex mcp add` takes a key only from an
 * environment variable, so it goes in as `http_headers` right under the header.
 */
export function codexWithKey(toml: string, key: string): string {
  const head = `[mcp_servers.${MCP_NAME}]`;
  const lines = toml.split("\n").filter((l) => !/^http_headers\s*=.*ctk_/.test(l)); // an earlier key of ours
  const at = lines.findIndex((l) => l.trim() === head);
  if (at < 0) throw new Error("Codex didn't save the server");
  lines.splice(at + 1, 0, `http_headers = { Authorization = "Bearer ${key}" }`);
  return lines.join("\n");
}

const reason = (out: Out | null, key: string): string => {
  if (!out) return MISSING;
  const text = (out.stderr || out.stdout || "").trim().slice(0, 300);
  return key ? text.replaceAll(key, "…") : text;
};

/** Writes this server's entry, with `key`, into one CLI. A claude entry refused as existing is removed and added again. */
async function writeEntry(id: CliId, key: string, port: number): Promise<void> {
  if (id === "claude") {
    const first = await runCli("claude", claudeMcpAdd(port, key), 30_000);
    if (first?.code === 0) return;
    if (first && /already exists/i.test(first.stdout + first.stderr)) {
      // refused by name: only now is the old entry removed, then the new one added
      await runCli("claude", ["mcp", "remove", "--scope", "user", MCP_NAME], 30_000);
      const again = await runCli("claude", claudeMcpAdd(port, key), 30_000);
      if (again?.code === 0) return;
      throw new Error(reason(again, key));
    }
    throw new Error(reason(first, key));
  }
  if (id === "codex") {
    if (!(await codexSupportsUrl())) throw new Error("Codex needs an update before it can use Creator Toolset.");
    const file = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "config.toml");
    let toml = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (!toml.includes(`[mcp_servers.${MCP_NAME}]`)) {
      const r = await runCli("codex", codexMcpAdd(port), 30_000);
      if (r?.code !== 0) throw new Error(reason(r, key));
      toml = readFileSync(file, "utf8");
    }
    // the new file is written beside the old one and renamed over it: the old entry is never gone before the new one exists
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, codexWithKey(toml, key), { mode: 0o600 });
    renameSync(tmp, file);
    return;
  }
  throw new Error("Creator Toolset isn't added to Gemini CLI in this release.");
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Makes one new Full key (the old one stops working) and writes it into every CLI that holds the entry, plus `id`.
 * `mcpTo` is what the setup file holds now. The returned `mcpTo` is the CLIs that took the new key. Nothing changes
 * when `id` is an old Codex or not found.
 */
export async function addMcp(username: string, id: CliId, mcpTo: CliId[], port: number): Promise<{ result: McpResult; mcpTo: CliId[] }> {
  const user: UserRecord | null = findUser(username);
  if (!user) return { result: { ok: false, added: [], failed: [{ id, message: "Sign in with an account first." }] }, mcpTo };
  if (id === "gemini") return { result: { ok: false, added: [], failed: [{ id, message: "Creator Toolset isn't added to Gemini CLI in this release. Your AI is still connected." }] }, mcpTo };
  const p = await probe(id, true);
  const stop = (message: string): { result: McpResult; mcpTo: CliId[] } => ({ result: { ok: false, added: [], failed: [{ id, message }] }, mcpTo });
  if (!p.found) return stop(`Creator Toolset couldn't be added to ${NAMES[id]}: ${MISSING} Your AI is still connected.`);
  if (id === "codex" && !p.supportsUrl) return stop("Codex needs an update before it can use Creator Toolset.");

  const targets = [...new Set<CliId>([...mcpTo, id])];
  const key = newApiKey(user, "full");
  const added: CliId[] = [];
  const failed: McpResult["failed"] = [];
  for (const t of targets) {
    try {
      await writeEntry(t, key, port);
      added.push(t);
    } catch (e) {
      failed.push({ id: t, message: `Creator Toolset couldn't be added to ${NAMES[t]}: ${plainError(errText(e)).message} Your AI is still connected.` });
    }
  }
  // only the CLIs that now hold the new key stay listed as added; a failed one shows its action again (Try again is the same action)
  return { result: { ok: failed.length === 0, added, failed }, mcpTo: added };
}
