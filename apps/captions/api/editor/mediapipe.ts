import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { env } from "../lib/env";
import { REQUIREMENTS } from "./mediapipe-requirements";

/**
 * The Python the AI Editor's face steps run on (Face refinement, Blur faces: plug-in folders in editor-steps/): one venv
 * with MediaPipe and OpenCV, made once from the pinned list in mediapipe-requirements.ts, in
 * <data dir>/runtime/mediapipe-<hash of the list>. Made the first time a step that needs it runs, never before the
 * person has switched that step on. `ready` is written only after the step's own self-test passed, so a broken
 * install is made again. The subject tracker (subject.ts) makes its own venv the same way, from its own list.
 */

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
/** A pinned list's own venv: <data dir>/runtime/<name>-<hash of the list>. */
const venvOf = (name: string, reqs: string) => path.join(env.dataDir, "runtime", `${name}-${sha1(reqs).slice(0, 8)}`);
export const venvDir = () => venvOf("mediapipe", REQUIREMENTS);

export function run(cmd: string, args: string[], opts: { env?: NodeJS.ProcessEnv; timeout?: number } = {}): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { env: opts.env, timeout: opts.timeout ?? 15 * 60_000, maxBuffer: 16 << 20 }, (e, stdout, stderr) =>
      e ? reject(new Error(`${String(stderr || e.message).trim().slice(-600)}`)) : resolve(stdout),
    ),
  );
}

/** A Python 3.<min> to 3.14 (the versions a list is pinned for) with venv. On a Mac, /usr/bin/python3 is a stub that opens an installer unless the developer tools are there. */
async function findPython(min: number): Promise<string | null> {
  const mac = process.platform === "darwin";
  const devTools = mac ? await run("xcode-select", ["-p"], { timeout: 5000 }).then(() => true, () => false) : true;
  const candidates = [
    ...(mac ? ["/opt/homebrew/bin/python3", "/usr/local/bin/python3", "/Library/Frameworks/Python.framework/Versions/Current/bin/python3"] : []),
    ...(devTools ? ["/usr/bin/python3"] : []),
    ...(mac ? [] : ["python3"]),
  ];
  for (const py of candidates) {
    if (py.startsWith("/") && !existsSync(py)) continue;
    const ok = await run(py, ["-I", "-c", `import sys, venv, ensurepip; assert (3, ${min}) <= sys.version_info[:2] <= (3, 14)`], { timeout: 20_000 }).then(() => true, () => false);
    if (ok) return py;
  }
  return null;
}

/** A pinned list of packages and the venv it makes. */
export interface PyList {
  name: string;
  requirements: string;
  /** the oldest Python 3 minor it is pinned for */
  minPython: number;
  /** what it holds, for an error: "MediaPipe and OpenCV" */
  holds: string;
}
const MEDIAPIPE: PyList = { name: "mediapipe", requirements: REQUIREMENTS, minPython: 9, holds: "MediaPipe and OpenCV" };

async function setUp(list: PyList, title: string, selftest: (python: string) => Promise<unknown>, onInstall: () => void): Promise<string> {
  const venv = venvOf(list.name, list.requirements);
  const python = path.join(venv, "bin", "python");
  const ready = path.join(venv, "ready");
  if (existsSync(ready)) return python;
  onInstall();
  const system = await findPython(list.minPython);
  if (!system) throw new Error(`${title} needs Python 3.${list.minPython} to 3.14 on this computer: install it from python.org${process.platform === "darwin" ? " (or run xcode-select --install)" : ""}, then run the edit again`);
  await rm(venv, { recursive: true, force: true });
  await mkdir(path.dirname(venv), { recursive: true });
  const step = (what: string) => (e: Error) => {
    throw new Error(`${title} could not ${what}: ${e.message}`);
  };
  await run(system, ["-m", "venv", venv]).catch(step(`make its own Python (with ${system})`));
  const reqFile = path.join(venv, "requirements.txt");
  await writeFile(reqFile, list.requirements);
  // exactly the packages it was tested with: every one, dependencies too, by version and hash, wheels only
  await run(python, ["-m", "pip", "install", "--no-cache-dir", "--disable-pip-version-check", "-q", "--require-hashes", "--only-binary=:all:", "-r", reqFile], { timeout: 30 * 60_000 }).catch(step(`install ${list.holds} in its own Python`));
  await selftest(python).catch(step("start its engine"));
  await writeFile(ready, list.requirements);
  return python;
}

// one install of each list at a time for every step that asks (each folder plug-in is its own bundle; this file is the app's one copy)
const setting = new Map<string, Promise<string>>();
const installing = new Set<string>();

/**
 * The venv's python, made first when it isn't there. `selftest` runs the asking step's engine once on a new install.
 * `onInstall` is called when an install really starts (or is already under way), so the step can say so on the edit.
 */
export function ensureMediapipe(title: string, selftest: (python: string) => Promise<unknown>, onInstall: () => void = () => {}): Promise<string> {
  if (process.platform === "darwin" && process.arch !== "arm64") return Promise.reject(new Error(`${title} needs a Mac with Apple silicon (its face models have no Intel build)`));
  // Darwin 22 is macOS 13: OpenCV 5's Mac build starts there
  if (process.platform === "darwin" && Number(os.release().split(".")[0]) < 22) return Promise.reject(new Error(`${title} needs macOS 13 or newer`));
  return ensureVenv(MEDIAPIPE, title, selftest, onInstall);
}

/** ensureMediapipe for any pinned list (subject.ts: the subject tracker's). */
export function ensureVenv(list: PyList, title: string, selftest: (python: string) => Promise<unknown>, onInstall: () => void = () => {}): Promise<string> {
  if (installing.has(list.name)) onInstall();
  let p = setting.get(list.name);
  if (!p) {
    p = setUp(list, title, selftest, () => (installing.add(list.name), onInstall()))
      .finally(() => installing.delete(list.name))
      .catch((e) => (setting.delete(list.name), Promise.reject(e)));
    setting.set(list.name, p);
  }
  return p;
}

/** Runs a step's Python engine; its own process group, so an abort ends its ffmpeg and workers too. */
export function engineRun(python: string, args: string[], signal: AbortSignal, extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error("stopped")); // stopped while it waited for its turn
    const p = spawn(python, ["-I", ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...extraEnv } });
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out = (out + d.toString()).slice(-100_000)));
    p.stderr.on("data", (d) => (err = (err + d.toString()).slice(-3000)));
    const stop = () => {
      try {
        process.kill(-p.pid!, "SIGTERM");
      } catch {
        // already gone
      }
    };
    signal.addEventListener("abort", stop, { once: true });
    p.on("error", reject);
    p.on("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (code === 0) resolve(out);
      else reject(new Error(signal.aborted ? "stopped" : err.split("\n").filter((l) => l && !/^[WI]\d{4} /.test(l)).slice(-3).join(" ") || `exited ${code}`));
    });
  });
}
