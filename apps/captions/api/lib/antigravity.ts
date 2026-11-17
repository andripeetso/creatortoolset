import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Antigravity is Google's agent server for editors: one program that speaks the Agent Client Protocol (JSON lines on
 * stdin and stdout) and a harness program beside it. Google publishes no command to install; the app downloads its
 * release itself, from Google's own download site, into its own data folder:
 *
 *   <app folder>/antigravity/runtime/   the two programs and release.json (version and sizes, written last)
 *   <app folder>/antigravity/profile/   the sign-in (GEMINI_HOME): antigravity-acp/acp_token.json once signed in
 *
 * The Mac app starts the same files for a chat (apps/mac Antigravity.swift), so both read the paths below. The app ships
 * none of Google's code: a person's own computer downloads it from Google (THIRD_PARTY_NOTICES.md).
 */

export const AGY_VERSION = "1.4.5";

export interface AgyRelease {
  version: string;
  url: string;
  sha256: string;
  /** the zip's size; its two files and their sizes follow */
  bytes: number;
  files: Array<{ name: string; bytes: number }>;
}

const DL = "https://dl.google.com/agy-extensions/releases";
const unix = (exe: number, harness: number) => [
  { name: "agy_acp_server.par", bytes: exe },
  { name: "localharness_external", bytes: harness },
];
const windows = (exe: number, harness: number) => [
  { name: "agy_acp_server.exe", bytes: exe },
  { name: "localharness_external.exe", bytes: harness },
];

/** Google's release 1.4.5 for each platform it publishes (sizes and SHA-256 of that release). A newer one is a deliberate change here. */
export const AGY_RELEASES: Record<string, AgyRelease> = {
  "darwin-arm64": { version: AGY_VERSION, url: `${DL}/macos/agy-acp-server-${AGY_VERSION}-darwin-arm64.zip`, sha256: "886fff7767d08994ca39eb02c3d01a7532c7325a94aa33aaf52d52068733284f", bytes: 97_923_855, files: unix(178_915_920, 122_957_936) },
  "darwin-x64": { version: AGY_VERSION, url: `${DL}/macos/agy-acp-server-${AGY_VERSION}-darwin-x86_64.zip`, sha256: "b39f3573c03b9acb9df028853f647527f1f3133f32bd77e78b796e48a205114a", bytes: 103_577_295, files: unix(183_127_600, 127_612_208) },
  "linux-x64": { version: AGY_VERSION, url: `${DL}/linux/agy-acp-server-${AGY_VERSION}-linux-x86_64.zip`, sha256: "923923a0d7dc8073f66cc6f78647a3107e3a7ee2b7e1a24df8b3927b5188013b", bytes: 321_783_181, files: unix(826_226_766, 133_926_136) },
  "linux-arm64": { version: AGY_VERSION, url: `${DL}/linux/agy-acp-server-${AGY_VERSION}-linux-arm64.zip`, sha256: "7d64246633ae094f67e3bbcd2d679e89048f91346d5339313336e7483f40f056", bytes: 307_829_008, files: unix(831_194_025, 127_512_832) },
  "win32-x64": { version: AGY_VERSION, url: `${DL}/windows/agy-acp-server-${AGY_VERSION}-windows-x86_64.zip`, sha256: "d24f4c73c9f96d4f44384e281c855a56c72d8eaa9c5b0fad7ccb1635c6b63f50", bytes: 100_423_655, files: windows(55_839_864, 147_843_736) },
  "win32-arm64": { version: AGY_VERSION, url: `${DL}/windows/agy-acp-server-${AGY_VERSION}-windows-arm64.zip`, sha256: "ab0a9aac8349e08ef289be6d16da8f89e3abe60eba5158032ef78c4a1220261c", bytes: 102_703_121, files: windows(62_293_488, 139_322_008) },
};

export const agyRelease = (platform: string = process.platform, arch: string = process.arch): AgyRelease | null => AGY_RELEASES[`${platform}-${arch}`] ?? null;

/** The app's data folder (CT_APP_FOLDER, set by the Mac app's Server.swift) and Antigravity's place in it. */
export const agyRoot = (): string =>
  path.join(process.env.CT_APP_FOLDER || path.join(os.homedir(), "Library", "Application Support", "Creator Toolset"), "antigravity");

export interface AgyRuntime {
  exe: string;
  harness: string;
  version: string;
}

/** The installed runtime: release.json and both files at the sizes it names, else null (a half-finished install is none). */
export function agyInstalled(root = agyRoot()): AgyRuntime | null {
  const dir = path.join(root, "runtime");
  try {
    const rec = JSON.parse(readFileSync(path.join(dir, "release.json"), "utf8")) as { version?: unknown; files?: Array<{ name?: unknown; bytes?: unknown }> };
    const files = rec.files ?? [];
    if (typeof rec.version !== "string" || files.length !== 2) return null;
    for (const f of files) {
      if (typeof f.name !== "string" || f.name.includes("/") || statSync(path.join(dir, f.name)).size !== f.bytes) return null;
    }
    return { exe: path.join(dir, String(files[0]!.name)), harness: path.join(dir, String(files[1]!.name)), version: rec.version };
  } catch {
    return null;
  }
}

/** Signed in: the token the sign-in saves is there (existence only; the program reads its own file). */
export const agySignedIn = (root = agyRoot()): boolean => existsSync(path.join(root, "profile", "antigravity-acp", "acp_token.json"));

/**
 * The environment the program runs with: its own profile folder, the harness beside it, its file token store (no
 * Keychain prompt), and no API keys (the Google account only, never API billing). BROWSER: unset lets Python open the
 * default browser (the sign-in only); a chat run gets a program that opens nothing.
 */
export function agyEnv(rt: Pick<AgyRuntime, "harness">, profile = path.join(agyRoot(), "profile"), browser?: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_GENAI_USE_VERTEXAI", "BROWSER"]) delete env[k];
  return {
    ...env,
    GEMINI_HOME: profile,
    ANTIGRAVITY_HARNESS_PATH: rt.harness,
    AGY_ACP_FORCE_FILE_STORAGE: "1",
    PYTHONUNBUFFERED: "1",
    ...(browser ? { BROWSER: browser } : {}),
  };
}

/** Linux builds need an empty --uid (Google's own launch line); the others take no arguments. */
const agyArgs = (): string[] => (process.platform === "linux" ? ["--uid="] : []);

/* ---- one ACP conversation with the program: requests by id, answers by id ---- */

interface Agent {
  child: ChildProcess;
  request: (method: string, params: object, ms: number) => Promise<{ result?: Record<string, unknown>; error?: { message?: string } }>;
}

function startAgent(rt: AgyRuntime, profile: string, browser?: string): Agent {
  const child = spawn(rt.exe, agyArgs(), { cwd: profile, env: agyEnv(rt, profile, browser), stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message?: string } }) => void>();
  let next = 0;
  let buf = "";
  child.stdout?.on("data", (d: Buffer) => {
    buf += d.toString();
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      try {
        const m = JSON.parse(line) as { id?: number; result?: Record<string, unknown>; error?: { message?: string } };
        if (typeof m.id === "number") waiting.get(m.id)?.(m);
      } catch {
        // not a protocol line
      }
    }
  });
  child.stderr?.resume(); // its log; never read, but drained so it can't fill the pipe
  child.stdin?.on("error", () => {}); // a child that died early must not crash the server
  child.on("error", () => {});
  const request: Agent["request"] = (method, params, ms) =>
    new Promise((resolve) => {
      const id = ++next;
      const done = (m: { result?: Record<string, unknown>; error?: { message?: string } }) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(m);
      };
      const timer = setTimeout(() => done({ error: { message: `no answer to ${method} in ${Math.round(ms / 1000)} s` } }), ms);
      child.once("exit", () => done({ error: { message: "the program stopped" } }));
      waiting.set(id, done);
      child.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  return { child, request };
}

/** The program starts and names itself as Google's release: what an install checks before it keeps the files. */
export async function agyLaunchCheck(rt: AgyRuntime, root: string): Promise<string | null> {
  // an empty profile of its own: the check never touches the person's sign-in
  const scratch = path.join(root, `.check-${process.pid}-${Date.now()}`);
  mkdirSync(scratch, { recursive: true });
  const agent = startAgent(rt, scratch, "true");
  try {
    const r = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 90_000);
    const info = r.result?.agentInfo as { name?: string; version?: string } | undefined;
    if (r.error) return r.error.message ?? "it didn't start";
    return info?.name === "antigravity-acp" && info.version === rt.version ? null : `it named itself ${info?.name ?? "nothing"} ${info?.version ?? ""}`.trim();
  } finally {
    agent.child.kill();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* ---- install ---- */

/** The download in progress (bytes so far of the total), for the row's line; null when none runs. */
let progress: { done: number; total: number } | null = null;
export const agyProgress = () => progress;

export interface AgyInstallDeps {
  /** tests: a made-up release in place of this computer's */
  release?: AgyRelease | null;
  fetch?: typeof fetch;
  /** unpacks the zip into an empty folder */
  extract?: (zip: string, into: string) => Promise<void>;
  check?: (rt: AgyRuntime, root: string) => Promise<string | null>;
  freeBytes?: (dir: string) => number;
}

const execP = promisify(execFile);
/** The system's own unzip: bsdtar reads zip on macOS and Windows; Linux has unzip. */
const systemExtract = async (zip: string, into: string): Promise<void> => {
  if (process.platform === "linux") await execP("unzip", ["-q", zip, "-d", into], { timeout: 10 * 60_000 });
  else await execP("tar", ["-xf", zip, "-C", into], { timeout: 10 * 60_000 });
};
const statFree = (dir: string): number => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};

/** One sentence for the person; the raw text for Details. */
export interface AgyFailure {
  message: string;
  raw?: string;
}

const MB = 1024 * 1024;
let installing: Promise<AgyFailure | null> | null = null;

/**
 * Downloads Google's release for this computer, checks its size and SHA-256 before anything is unpacked, unpacks it to a
 * folder of its own, checks each file's size and that the program starts and names itself, and only then puts it in
 * place of the one before (an update is the same install). Presses that overlap share one install.
 */
export function installAgy(root = agyRoot(), deps: AgyInstallDeps = {}): Promise<AgyFailure | null> {
  installing ??= runInstall(root, deps).finally(() => {
    installing = null;
    progress = null;
  });
  return installing;
}

async function runInstall(root: string, deps: AgyInstallDeps): Promise<AgyFailure | null> {
  const rel = deps.release === undefined ? agyRelease() : deps.release;
  if (!rel) return { message: `Google publishes no Antigravity for this computer (${process.platform}, ${process.arch}).` };
  mkdirSync(root, { recursive: true });
  const need = rel.bytes + rel.files.reduce((n, f) => n + f.bytes, 0) + 256 * MB;
  const free = (deps.freeBytes ?? statFree)(root);
  if (free < need) return { message: `Antigravity needs ${Math.ceil(need / MB)} MB free on this computer's disk. Free some space, then try again.` };
  const staging = path.join(root, `.install-${process.pid}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    const zip = path.join(staging, "download.zip");
    const failed = await download(rel, zip, deps.fetch ?? fetch);
    if (failed) return failed;
    const dir = path.join(staging, "runtime");
    mkdirSync(dir);
    try {
      await (deps.extract ?? systemExtract)(zip, dir);
    } catch (e) {
      return { message: "Could not unpack Antigravity. Try again.", raw: errText(e) };
    }
    rmSync(zip, { force: true });
    const names = readdirSync(dir).sort();
    const sized = rel.files.every((f) => existsSync(path.join(dir, f.name)) && statSync(path.join(dir, f.name)).size === f.bytes);
    if (names.length !== rel.files.length || !sized) return { message: "The Antigravity download had other files than Google's release, so nothing was installed.", raw: names.join(", ") };
    for (const f of rel.files) chmodSync(path.join(dir, f.name), 0o755);
    const rt = { exe: path.join(dir, rel.files[0]!.name), harness: path.join(dir, rel.files[1]!.name), version: rel.version };
    // Google signs the Intel Mac build without the permission its Python needs to run generated code: signed again
    // here for this Mac alone, after the hash check
    if (process.platform === "darwin" && process.arch === "x64") {
      try {
        await execP("/usr/bin/codesign", ["--force", "--sign", "-", rt.exe, rt.harness], { timeout: 120_000 });
      } catch (e) {
        return { message: "Could not prepare Antigravity for this Mac. Try again.", raw: errText(e) };
      }
    }
    const bad = await (deps.check ?? agyLaunchCheck)(rt, root);
    if (bad) return { message: "Antigravity was downloaded but didn't start on this computer. Try again.", raw: bad };
    writeFileSync(path.join(dir, "release.json"), `${JSON.stringify({ version: rel.version, files: rel.files })}\n`);
    // into place: the one before moves aside first (a chat still running keeps its open files) and is deleted after
    const live = path.join(root, "runtime");
    const old = path.join(staging, "old");
    if (existsSync(live)) renameSync(live, old);
    renameSync(dir, live);
    return null;
  } catch (e) {
    return { message: "Could not install Antigravity. Try again.", raw: errText(e) };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** The zip into `file`: its size and SHA-256 checked against the release as it streams; anything else is refused. */
async function download(rel: AgyRelease, file: string, get: typeof fetch): Promise<AgyFailure | null> {
  const failed = (raw: string): AgyFailure => ({ message: "Could not download Antigravity. Check the internet connection, then try again.", raw });
  let res: Response;
  try {
    res = await get(rel.url, { signal: AbortSignal.timeout(45 * 60_000) });
  } catch (e) {
    return failed(errText(e));
  }
  if (!res.ok || !res.body) return failed(`HTTP ${res.status}`);
  // a compressed answer's length is not the file's: only an identity answer's is compared before the bytes
  const length = res.headers.get("content-length");
  const encoding = res.headers.get("content-encoding");
  if ((!encoding || encoding === "identity") && length && Number(length) !== rel.bytes) return failed(`expected ${rel.bytes} bytes, the server said ${length}`);
  const hash = createHash("sha256");
  const out = createWriteStream(file, { mode: 0o600 });
  progress = { done: 0, total: rel.bytes };
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      progress.done += chunk.byteLength;
      if (progress.done > rel.bytes) return failed(`more than the release's ${rel.bytes} bytes`);
      hash.update(chunk);
      if (!out.write(chunk)) await new Promise<void>((r) => out.once("drain", () => r()));
    }
  } catch (e) {
    return failed(errText(e));
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  const sum = hash.digest("hex");
  if (progress.done !== rel.bytes || sum !== rel.sha256)
    return { message: "The Antigravity download didn't match Google's release, so nothing was installed. Try again.", raw: `${progress.done} bytes, sha256 ${sum}` };
  return null;
}

/** Deletes the downloaded program; the sign-in stays (a new install finds it signed in). */
export function removeAgy(root = agyRoot()): void {
  rmSync(path.join(root, "runtime"), { recursive: true, force: true });
}

/* ---- sign in ---- */

const LOGIN_MS = 5 * 60_000;
let login: ChildProcess | null = null;

/**
 * Google's browser sign-in: the program is asked to sign in with a Google account (`authenticate`, oauth-personal), opens
 * Google's page in the default browser and waits there for it; the answer saves the token (agySignedIn reads it) and ends
 * the child. Only this press opens a browser: a chat run's own start never does (agyEnv). The settings file names the
 * Google account as the way in, so a chat after this needs no sign-in step.
 */
export async function signInAgy(root = agyRoot(), browser?: string): Promise<AgyFailure | null> {
  const rt = agyInstalled(root);
  if (!rt) return { message: "Antigravity isn't installed on this computer yet." };
  login?.kill();
  const acpDir = path.join(root, "profile", "antigravity-acp");
  mkdirSync(acpDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(acpDir, "settings.json"), `${JSON.stringify({ auth: { type: "oauth-personal" } })}\n`);
  // `browser`: a program to hand Google's page to in place of the default browser (a check with nobody at the screen)
  const agent = startAgent(rt, path.join(root, "profile"), browser);
  login = agent.child;
  const started = await new Promise<boolean>((resolve) => {
    agent.child.once("spawn", () => resolve(true));
    agent.child.once("error", () => resolve(false));
  });
  if (!started) return { message: "Could not start the Antigravity sign-in. Try again." };
  const child = agent.child;
  void (async () => {
    const init = await agent.request("initialize", { protocolVersion: 1, clientCapabilities: {} }, 90_000);
    if (!init.error) await agent.request("authenticate", { methodId: "oauth-personal" }, LOGIN_MS);
    child.kill();
    if (login === child) login = null;
  })();
  return null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
