import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type CliId, type ConnectResult, type LocalAiRow, type LocalAiView, type McpResult, type SignInResult } from "../../contracts/local-ai";
import { planFromCli, type PlanId } from "../../contracts/plans";
import { addInstanceTo, DRIVERS, type Driver, type ProviderInstance } from "../../contracts/providers";
import { checkInstance } from "../providers";
import { connectedOwn, modelsFor, ownSettings, parseSettings, saveSettings } from "./providers";
import { deviceOf, isOnline } from "./devices";
import { dropAiKey, findUser, newAiKey, type UserRecord } from "../users";

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
const NAMES: Record<CliId, string> = { claude: "Claude Code", codex: "Codex", gemini: "Gemini" };
const isCli = (id: string): id is CliId => (CLI_IDS as string[]).includes(id);
/**
 * The name of this app's entry in the AI tools (claude mcp, codex). A copy of the Mac app beside the released one keeps
 * its data in "Creator Toolset (<name>)" (CT_APP_FOLDER): its entry is "creator-toolset-<name>", so trying the copy never
 * overwrites the entry the released app wrote.
 */
export const mcpName = (appFolder = process.env.CT_APP_FOLDER ?? ""): string => {
  const copy = appFolder.match(/\(([a-z0-9-]+)\)\/?$/i)?.[1];
  return copy ? `creator-toolset-${copy.toLowerCase()}` : "creator-toolset";
};
export const MCP_NAME = mcpName();
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
    const x = e as { stdout?: unknown; stderr?: unknown; code?: number | string; message?: string; killed?: boolean; signal?: string };
    // a command that was stopped says nothing itself: say that it ran out of time, so Details is never empty
    const stopped = x.killed || x.signal ? `stopped after ${Math.round(opt.timeout / 1000)} s without finishing` : "";
    return { stdout: String(x.stdout ?? ""), stderr: String(x.stderr || stopped || x.message || ""), code: x.code ?? null };
  }
};
let run: Runner = realRun;

const bins = new Map<CliId, string>();
let codexUrl: boolean | undefined;
const probes = new Map<CliId, { at: number; p: Probe }>();

/** Tests: a fake runner (and which fallback paths hold a copy: none unless said), and a clean cache. */
export function setRunnerForTests(r?: Runner, onDisk?: (p: string) => boolean): void {
  run = r ?? realRun;
  copyAt = r ? (onDisk ?? (() => false)) : isExecutable;
  bins.clear();
  probes.clear();
  codexUrl = undefined;
}

const isExecutable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

let copyAt: (p: string) => boolean = isExecutable;

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
export function fallbackCandidates(id: string, home: string, nvmDirs: string[]): string[] {
  return [
    `/opt/homebrew/bin/${id}`,
    `/usr/local/bin/${id}`,
    path.join(home, ".local", "bin", id),
    path.join(home, ".npm-global", "bin", id),
    path.join(home, ".volta", "bin", id),
    path.join(home, ".bun", "bin", id),
    ...nvmDirs.map((d) => path.join(d, "bin", id)),
    `/usr/bin/${id}`,
    // the Codex the ChatGPT app carries: OpenAI's own program with the same sign-in, so that person needs no download
    ...(id === "codex" ? ["/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex"] : []),
    // the Gemini CLI Connect installed: beside the app's own Node.js, which it runs on (installGemini)
    ...(id === "gemini" ? [geminiBin()] : []),
    // Grok's and OpenCode's own installers put them in a folder of their own (the Mac app looks there too)
    ...(id === "grok" || id === "opencode" ? [path.join(home, `.${id}`, "bin", id)] : []),
  ];
}

/** Forgets what was found about one CLI, so the next look reads the machine again (Check again after an install). */
export function forgetCli(id: CliId): void {
  bins.delete(id);
  probes.delete(id);
  if (id === "codex") codexUrl = undefined;
}

/** Where the managed Node.js is kept (installNode), and its bin folder. */
// CT_APP_FOLDER: the Mac app's own Application Support folder (Server.swift); the default is the released app's.
const nodeRoot = (): string =>
  path.join(process.env.CT_APP_FOLDER || path.join(os.homedir(), "Library", "Application Support", "Creator Toolset"), "node");
/** Where Connect installs Gemini CLI: in the managed Node's own bin folder, so the Node script finds its node beside it. */
const geminiBin = (): string => path.join(nodeRoot(), "bin", "gemini");
/** PATH for a spawn: the binary's own folder, the managed Node's (once this server installed it), then the rest. */
export const toolPath = (bin: string): string =>
  [path.dirname(bin), ...(existsSync(path.join(nodeRoot(), "bin")) ? [path.join(nodeRoot(), "bin")] : []), process.env.PATH ?? ""].join(":");

/** The version numbers in a `--version` line ("codex-cli 0.39.0" → [0, 39, 0]); [] when it names none. */
export const versionNumbers = (text: string): number[] => (/\d+(\.\d+)+/.exec(text)?.[0] ?? "").split(".").filter(Boolean).map(Number);
/** Whether version `a` is older than `b`, number by number. */
export function olderThan(a: number[], b: number[]): boolean {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d < 0;
  }
  return false;
}

/**
 * The copy of a CLI this Mac runs. Every copy counts: the login shell's, then the usual folders, each real file once.
 * With more than one (an old Homebrew Codex beside the one Install put in ~/.local/bin) the newest runs, since today's
 * models refuse an old Codex; the first found wins a tie. The Mac app picks the same way (MacReport.swift binary()).
 */
async function lookup(id: CliId): Promise<string | null> {
  // -i: nvm is usually set up in .zshrc, which only an interactive login shell reads
  const out = await run("/bin/zsh", ["-lic", `command -v ${id}`], { timeout: 5000 });
  const line = out.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")).pop();
  const home = os.homedir();
  const seen = new Set<string>();
  const copies = [...(line ? [line] : []), ...fallbackCandidates(id, home, nvmVersionDirs(home)).filter(copyAt)].filter((p) => {
    const real = safeReal(p) ?? p;
    return !seen.has(real) && !!seen.add(real);
  });
  if (copies.length < 2) return copies[0] ?? null;
  const versionAt = async (bin: string) => {
    const v = await run(bin, ["--version"], { env: { ...process.env, PATH: toolPath(bin) }, timeout: 5000 });
    return versionNumbers(v.stdout || v.stderr);
  };
  let best = copies[0]!;
  let bestVersion = await versionAt(best);
  for (const p of copies.slice(1)) {
    const v = await versionAt(p);
    if (olderThan(bestVersion, v)) [best, bestVersion] = [p, v];
  }
  return best;
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
  // "auth method": Gemini CLI with no sign-in chosen ("Please set an Auth method in your …/settings.json")
  if (/not logged in|\/login|log in|authentication|auth method|unauthorized|401/i.test(raw)) return { state: "signin", message: "Not signed in yet." };
  if (/timed out|timeout|did not pick up/i.test(raw)) return { state: "failed", message: "It took too long to answer. Try again." };
  if (/ENOENT|command not found|no such file/i.test(raw)) return { state: "missing", message: MISSING };
  return { state: "failed", message: "It didn't answer. Try again." };
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
  const v = await runCli(id, ["--version"], 10_000);
  // found only when --version exits 0: a timeout or a crash is not a found CLI (M-53). 10 s: Gemini CLI, a Node
  // script, took 2.7 s to answer on its first start after install
  if (!v || v.code !== 0) return { id, found: false, signedIn: null };
  const version = parseVersion(v.stdout || v.stderr);
  const bin = bins.get(id);
  const base: Probe = { id, found: true, version, signedIn: null, bin, real: bin ? safeReal(bin) : undefined };
  // Gemini CLI has no status command: its Google sign-in is the file it saves (existence only; GEMINI_CLI_HOME moves it).
  // While our sign-in still runs, it is not done yet: the file lands before Gemini sets up the account and saves the
  // sign-in method, and a run before that fails ("Please set an Auth method").
  if (id === "gemini") return { ...base, signedIn: !logins.has("gemini") && existsSync(path.join(process.env.GEMINI_CLI_HOME || home, ".gemini", "oauth_creds.json")) };
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

/* ---- the other AIs the Mac app runs ---- */

/**
 * The other AIs the Mac app runs (ClaudeRequest.swift runnableDrivers), by the command it starts (MacReport.swift
 * driverBinaries). Setup lists the ones on this Mac and connects them as they are set up there: it never installs one or
 * signs one in.
 */
export const OTHER_AIS: Partial<Record<Driver, string>> = { grok: "grok", cursor: "cursor-agent", opencode: "opencode", antigravity: "antigravity-acp", pi: "pi" };

/** The other AIs on this Mac: one login shell's `command -v` for all of them, then the usual folders (as lookup). */
export async function otherAis(home = os.homedir()): Promise<Driver[]> {
  const ids = Object.keys(OTHER_AIS) as Driver[];
  const out = await run("/bin/zsh", ["-lic", `command -v ${ids.map((id) => OTHER_AIS[id]).join(" ")}`], { timeout: 5000 });
  const onPath = new Set(out.stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("/")).map((l) => path.basename(l)));
  const nvm = nvmVersionDirs(home);
  return ids.filter((id) => onPath.has(OTHER_AIS[id]!) || fallbackCandidates(OTHER_AIS[id]!, home, nvm).some(copyAt));
}

/* ---- the view ---- */

/** The rows setup shows: each CLI, found on this Mac or not. */
export async function localAiView(username: string, mcpTo: CliId[], fresh = false): Promise<LocalAiView> {
  // fresh: Check again. Nothing cached is used, so a CLI installed a moment ago is found and its sign-in is read again.
  if (fresh) CLI_IDS.forEach(forgetCli);
  const [probed, found] = await Promise.all([Promise.all(CLI_IDS.map((id) => probe(id, fresh))), otherAis()]);
  const own = ownSettings(username)?.instances ?? [];
  const connected = (id: string) => {
    const inst = own.find((i) => i.id === `local-${id}`);
    return !!(inst?.enabled && inst.lastCheck?.ok);
  };
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
      connected: connected(p.id),
      ...(lastCheck ? { lastCheck } : {}),
      mcp,
      ...(mcp === "update" ? { updateCommand: codexUpdateCommand(p.bin ?? "", p.real) } : {}),
    });
  }
  return { local: true, rows, others: found.map((id) => ({ id, connected: connected(id) })) };
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

async function step(file: string, args: string[], env: NodeJS.ProcessEnv, message: string, timeout = STEP_MS): Promise<Failed | null> {
  const out = await run(file, args, { env, timeout });
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
      // 108 MB: a slow connection gets half an hour before this gives up, and a dropped one carries on where it stopped
      (await step("/usr/bin/curl", ["-fL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o", tgz, url], process.env, `Couldn't download ${NAMES.codex}. Check the internet connection, then try again.`, 30 * 60_000)) ??
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
    // 50 MB on a slow connection: half an hour, and a dropped download carries on where it stopped (as Codex's)
    const failed =
      (await step("/usr/bin/curl", ["-fL", "--retry", "5", "--retry-all-errors", "-C", "-", "-o", tgz, `${base}/${file}`], process.env, dl, 30 * 60_000)) ??
      (await step("/usr/bin/curl", ["-fL", "--retry", "5", "-o", sums, `${base}/SHASUMS256.txt`], process.env, dl));
    if (failed) return failed;
    const want = readFileSync(sums, "utf8").split("\n").find((l) => l.endsWith(`  ${file}`))?.split(" ")[0];
    const got = createHash("sha256").update(readFileSync(tgz)).digest("hex");
    if (!want || want !== got) return { message: "The Node.js download didn't check out, so it wasn't used. Try again.", raw: `expected ${want ?? "no checksum"}, got ${got}` };
    mkdirSync(nodeRoot(), { recursive: true });
    // awaited here: `finally` removes the download, and tar must have read it by then
    return await step("/usr/bin/tar", ["-xzf", tgz, "-C", nodeRoot(), "--strip-components", "1"], process.env, "Couldn't unpack Node.js. Try again.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Gemini CLI: Google's npm package, installed with the managed Node.js into that Node's own folder (geminiBin). The CLI
 * is a Node script: beside its node it runs from the Mac app too, which puts only the program's folder first on PATH.
 */
async function installGemini(): Promise<Failed | null> {
  if (!existsSync(path.join(nodeRoot(), "bin", "node"))) {
    const node = await installNode();
    if (node) return node;
  }
  return step(
    path.join(nodeRoot(), "bin", "npm"),
    ["install", "-g", "--prefix", nodeRoot(), "@google/gemini-cli"],
    envWith(path.join(nodeRoot(), "bin")),
    `Couldn't install ${NAMES.gemini}. Check the internet connection, then try again.`,
    30 * 60_000,
  );
}

/**
 * Installs one CLI by its vendor's own route, then runs the binary by its absolute path with --version: only a binary
 * that answers counts as installed. Nothing is shown as a command to paste.
 */
export async function installCli(id: CliId): Promise<SignInResult> {
  const failed = id === "claude" ? await installClaude() : id === "codex" ? await installCodex() : await installGemini();
  if (failed) return { ok: false, message: failed.message, raw: failed.raw };
  const bin = id === "gemini" ? geminiBin() : path.join(localBin(), id);
  const v = await run(bin, ["--version"], { env: { ...process.env, PATH: toolPath(bin) }, timeout: 15_000 });
  forgetCli(id); // the next look reads the machine again
  if (v.code !== 0) return { ok: false, message: `${NAMES[id]} installed, but it didn't start. Try again.`, raw: tailOf(v) };
  return { ok: true, message: `${NAMES[id]} is installed.` };
}

/* ---- sign in: the vendor's own sign-in runs as a child process; the page polls until it is done ---- */

/** The sign-in commands running now, one per CLI: a new press ends the older one. */
const logins = new Map<CliId, ChildProcess>();

/**
 * Gemini CLI has no sign-in command. Its editor mode (`--acp`, the Agent Client Protocol: JSON lines on stdin and stdout)
 * signs in when asked: `authenticate` with its Google-account method opens Google's sign-in in the browser, waits for it
 * (five minutes at most), saves the login (probeCli reads that) and answers. The answer, either way, ends the child.
 */
function geminiLogin(bin: string): ChildProcess {
  const child = spawn(bin, ["--acp"], { env: { ...process.env, PATH: toolPath(bin) }, stdio: ["pipe", "pipe", "pipe"] });
  const send = (id: number, method: string, params: object) => child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg: { id?: unknown };
      try {
        msg = JSON.parse(line) as { id?: unknown };
      } catch {
        continue;
      }
      if (msg.id === 1) send(2, "authenticate", { methodId: "oauth-personal" });
      else if (msg.id === 2) child.kill();
    }
  });
  child.stdin?.on("error", () => {}); // a child that died early must not crash the server
  send(1, "initialize", { protocolVersion: 1, clientCapabilities: {} });
  return child;
}

/** Starts the vendor's sign-in (its browser opens) as a child process. The page checks the sign-in every few seconds until it is done. */
export async function signIn(id: CliId): Promise<SignInResult> {
  const bin = await binFor(id);
  if (!bin) return { ok: false, message: MISSING };
  logins.get(id)?.kill();
  const child =
    id === "gemini"
      ? geminiLogin(bin)
      : spawn(bin, id === "claude" ? ["auth", "login"] : ["login"], { env: { ...process.env, PATH: toolPath(bin) }, stdio: ["ignore", "pipe", "pipe"] });
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
export async function connectCli(username: string, id: Driver, home = os.homedir(), mac?: string): Promise<ConnectResult> {
  // another AI the Mac app runs: found on this Mac, never installed or signed in here; the check says whether it answers
  const p = isCli(id) ? await probe(id, true, home) : { found: (await otherAis(home)).includes(id), signedIn: null, home: undefined };
  if (!p.found) return { state: "missing", signedIn: null, answered: null, message: MISSING };
  if (p.signedIn === false) return { state: "signin", signedIn: false, answered: null, message: "Not signed in yet." };
  // this server's own Mac: a device of this account that is answering now, never the first online one of its Macs
  const device = mac ? deviceOf(mac) : undefined;
  if (!device || device.owner !== username || !isOnline(device.id)) return { state: "mac", signedIn: p.signedIn, answered: null, message: MAC_ONLY };

  const instId = `local-${id}`;
  const name = isCli(id) ? NAMES[id] : (DRIVERS.find((d) => d.id === id)?.label ?? id);
  const inst: ProviderInstance = { id: instId, driver: id, name, enabled: true, device: device.id, ...(p.home ? { home: p.home } : {}) };
  // the same writer as the Settings page's Add provider: addInstanceTo builds the set, parseSettings checks it.
  // A first AI becomes the default with the first model this login really has (modelsFor), not the catalogue's.
  const cur = ownSettings(username);
  const built = addInstanceTo(cur, inst);
  const first = modelsFor(inst)[0];
  const next = parseSettings(!cur?.default.instance && first ? { ...built, default: { ...built.default, model: first } } : built, username, { trustedFolder: true });

  // the check runs before anything is saved: a failed check leaves the saved set, its default included, as it was
  const check = await checkInstance(username, inst, next);
  if (!check.ok) {
    // today's models refuse an old Codex ("requires a newer version of Codex"): the page installs the current one and connects again
    if (id === "codex" && /requires a newer version|not supported when using Codex|model_not_found/i.test(check.error ?? ""))
      return { state: "outdated", signedIn: p.signedIn, answered: false, ms: check.ms, message: "ChatGPT didn't accept this. Try again later.", raw: check.error };
    const plain = plainError(check.error ?? "");
    if (plain.state === "signin") return { state: "signin", signedIn: false, answered: false, message: plain.message, raw: check.error };
    return { state: "failed", signedIn: p.signedIn, answered: false, ms: check.ms, message: plain.message, raw: check.error };
  }
  await saveSettings({ ...next, instances: next.instances.map((i) => (i.id === instId ? { ...i, lastCheck: { ok: true, at: check.at, ms: check.ms, ...(check.note ? { note: check.note } : {}) } } : i)) }, username);
  // a plan at its limit is connected all the same: the message says when it resets
  return { state: "ready", signedIn: p.signedIn, answered: !check.note, ms: check.ms, ...(check.note ? { message: check.note } : {}) };
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
 * Install on Settings → Headless access: makes `id` a Full key of its own (its earlier one goes, the other apps' keys stay) and
 * writes it into that CLI. `mcpTo` is what the setup file holds now; the returned one lists `id` only once it took the
 * key. Nothing changes when `id` is an old Codex or not found.
 */
export async function addMcp(username: string, id: CliId, mcpTo: CliId[], port: number): Promise<{ result: McpResult; mcpTo: CliId[] }> {
  const user: UserRecord | null = findUser(username);
  if (!user) return { result: { ok: false, added: [], failed: [{ id, message: "Sign in with an account first." }] }, mcpTo };
  if (id === "gemini") return { result: { ok: false, added: [], failed: [{ id, message: "Creator Toolset isn't added to Gemini CLI in this release." }] }, mcpTo };
  const p = await probe(id, true);
  const stop = (message: string): { result: McpResult; mcpTo: CliId[] } => ({ result: { ok: false, added: [], failed: [{ id, message }] }, mcpTo });
  if (!p.found) return stop(`Creator Toolset couldn't be added to ${NAMES[id]}: ${MISSING}`);
  if (id === "codex" && !p.supportsUrl) return stop("Codex needs an update before it can use Creator Toolset.");

  const others = mcpTo.filter((t) => t !== id);
  const earlier = (user.aiKeys ?? []).filter((k) => k.name === NAMES[id]);
  const { id: keyId, key } = newAiKey(user, NAMES[id]);
  try {
    await writeEntry(id, key, port);
  } catch (e) {
    dropAiKey(user, keyId);
    return { result: { ok: false, added: [], failed: [{ id, message: `Creator Toolset couldn't be added to ${NAMES[id]}: ${plainError(errText(e)).message}` }] }, mcpTo: others };
  }
  // the CLI now holds the new key: its earlier ones would only be rows that no longer work
  for (const k of earlier) dropAiKey(user, k.id);
  return { result: { ok: true, added: [id], failed: [] }, mcpTo: [...others, id] };
}

/** Codex too old to take an address: its own update (brew or npm, as it was installed), run here. */
export async function updateCli(id: CliId): Promise<SignInResult> {
  if (id !== "codex") return { ok: false, message: `${NAMES[id]} doesn't need an update here.` };
  const p = await probe(id, true);
  if (!p.found || !p.bin) return { ok: false, message: MISSING };
  const out = await run("/bin/zsh", ["-lc", codexUpdateCommand(p.bin, p.real)], { env: { ...process.env, PATH: toolPath(p.bin) }, timeout: STEP_MS });
  forgetCli(id);
  if (out.code !== 0) return { ok: false, message: "Codex didn't update. Try again.", raw: tailOf(out) };
  return (await probe(id, true)).supportsUrl ? { ok: true, message: "Codex is updated." } : { ok: false, message: "Codex updated, but it is still too old for this." };
}
