import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Hono } from "hono";
import { admissionProblem, type ServerPlugin } from "./plugin";

// Plug-ins from the person's own folder, for the server the Mac app runs on their Mac (CT_LOCAL=1 with CT_APP_FOLDER).
// A hosted or Docker server never reads a folder: there a plug-in would see every account's data, so its plug-ins
// are compiled in (scripts/plugins.mjs).
//
//   <app folder>/plugins/<name>/                       what the person's AI writes (plugin.ts, web.tsx, …)
//   <app folder>/plugins-approved/<id>/<fingerprint>/  the copy taken when they clicked Switch on
//   <app folder>/plugins-run/<id>/                     that copy built for this start (remade at every start)
//   <app folder>/plugins-state.json                    which plug-in was loading, and which stopped the server
//
// Only the Mac app says what is on: CT_PLUGINS_ON="id:fingerprint,…", from the list it keeps of the person's own clicks.
// A plug-in runs only from its approved copy, and only while that copy still has its fingerprint. Each one is built
// (scripts/plugin-build.mjs), loaded and checked by itself: one that fails is left out and named, and the app starts.

const MAX_FILES = 2000;
const MAX_BYTES = 20 * 1024 * 1024;
const LOAD_TIMEOUT_MS = 20_000;

const appFolder = () => process.env.CT_APP_FOLDER ?? "";
/** True on the Mac app's own server. Everything in this file does nothing anywhere else. */
export const folderPluginsEnabled = (): boolean => process.env.CT_LOCAL === "1" && !!appFolder();
const dir = (name: "plugins" | "plugins-approved" | "plugins-run") => path.join(appFolder(), name);
const stateFile = () => path.join(appFolder(), "plugins-state.json");

/** The builder: beside the app's source in the Mac app (Resources/server/source), in scripts/ in a checkout. */
const builder = (): string =>
  process.env.CT_PLUGIN_BUILDER ?? [path.resolve("source/scripts/plugin-build.mjs"), path.resolve("scripts/plugin-build.mjs")].find((f) => existsSync(f)) ?? "";

export interface FolderPluginRow {
  /** The folder's name in plugins/ ("" when the folder is gone and only the approved copy is left). */
  folder: string;
  /** The plug-in's own id, once it could be read from its files. */
  id: string | null;
  name: string;
  about: string;
  /** The person switched it on (the Mac app's list). */
  on: boolean;
  /** It is loaded in this server. */
  running: boolean;
  /** The folder is no longer what they approved: the approved copy keeps running until they take the new one. */
  changed: boolean;
  /** Why it isn't running, or what is wrong with the folder. */
  error?: string;
}

/** What a plug-in says it is, as scripts/plugin-build.mjs writes it (plugin.json). */
interface Built {
  id: string;
  name: string;
  about: string;
  server: boolean;
  web: boolean;
  needs: { server: string[]; web: string[] };
}

interface State {
  /** Set while a plug-in loads or starts. Still set at the next start = the server died or hung on it. */
  loading: { id: string; fingerprint: string } | null;
  /** Plug-ins that stopped the server: skipped until they are switched off, or approved again in a new version. */
  stopped: Record<string, { fingerprint: string; error: string }>;
}

const readState = (): State => {
  try {
    const s = JSON.parse(readFileSync(stateFile(), "utf8")) as Partial<State>;
    return { loading: s.loading ?? null, stopped: s.stopped ?? {} };
  } catch {
    return { loading: null, stopped: {} };
  }
};
const writeState = (s: State) => {
  mkdirSync(appFolder(), { recursive: true });
  writeFileSync(stateFile(), JSON.stringify(s, null, 1));
};

/** A folder's files (hidden ones and node_modules left out), in a fixed order. Throws when it is too big to be a plug-in. */
function readFolder(root: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let bytes = 0;
  const walk = (rel: string) => {
    for (const d of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (d.name.startsWith(".") || d.name === "node_modules") continue;
      const at = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) walk(at);
      else if (d.isFile()) {
        const data = readFileSync(path.join(root, at));
        bytes += data.length;
        if (files.size >= MAX_FILES || bytes > MAX_BYTES) throw new Error("The folder is too big for a plug-in (over 2,000 files or 20 MB)");
        files.set(at, data);
      }
    }
  };
  walk("");
  return files;
}

/** The fingerprint of a set of files: every path and every byte counts. */
export function fingerprintOf(files: Map<string, Buffer>): string {
  const h = createHash("sha256");
  for (const [rel, data] of files) h.update(`${rel}\0${data.length}\0`).update(data);
  return h.digest("hex");
}

function writeFolder(root: string, files: Map<string, Buffer>): void {
  rmSync(root, { recursive: true, force: true });
  for (const [rel, data] of files) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), data);
  }
}

/** Runs the builder on a folder. Nothing of the plug-in runs: its files are read and bundled. Rejects with what is wrong. */
function build(src: string, out: string): Promise<Built> {
  return new Promise((resolve, reject) => {
    const script = builder();
    if (!script) return reject(new Error("This copy of the app has no plug-in builder"));
    const child = spawn(process.execPath, [script, "build", src, out], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `The builder stopped (${code})`));
      try {
        resolve(JSON.parse(stdout) as Built);
      } catch {
        reject(new Error("The builder gave no answer"));
      }
    });
  });
}

/** `id:fingerprint,…` from the Mac app. Anything malformed is dropped. */
export function parseOn(value: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (value ?? "").split(",")) {
    const m = /^([a-z0-9][a-z0-9-]{0,39}):([a-f0-9]{64})$/.exec(pair.trim());
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

const paused = () => process.env.CT_PLUGINS_PAUSED === "1";

// ---- what this start loaded ----

const running = new Map<string, Built>();
const webFiles = new Map<string, { js: Buffer; css: Buffer | null }>();
const failures = new Map<string, string>();
const fromFolder = new Set<ServerPlugin>();

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The server halves of the plug-ins the person switched on, each admitted by itself against `compiled` and the ones
 * before it. Called once by boot.ts before anything is mounted. Never throws: a plug-in that can't load is in `failures`.
 */
export async function loadFolderPlugins(compiled: ServerPlugin[], more?: (all: ServerPlugin[]) => void): Promise<ServerPlugin[]> {
  const loaded: ServerPlugin[] = [];
  if (!folderPluginsEnabled()) return loaded;
  const on = parseOn(process.env.CT_PLUGINS_ON);
  const state = readState();
  if (state.loading) {
    state.stopped[state.loading.id] = { fingerprint: state.loading.fingerprint, error: "It stopped the app's server while starting." };
    state.loading = null;
  }
  // switched off, or approved again in another version: its old record no longer holds
  for (const id of Object.keys(state.stopped)) if (on.get(id) !== state.stopped[id]!.fingerprint) delete state.stopped[id];
  writeState(state);
  rmSync(dir("plugins-run"), { recursive: true, force: true });
  if (!on.size || paused()) return loaded;

  // build them all at once, then load one at a time
  const builds = await Promise.all(
    [...on].map(async ([id, fingerprint]): Promise<{ id: string; fingerprint: string; built?: Built; out: string; error?: string }> => {
      const out = path.join(dir("plugins-run"), id, "out");
      try {
        if (state.stopped[id]) throw new Error(state.stopped[id]!.error);
        const approved = path.join(dir("plugins-approved"), id, fingerprint);
        const files = existsSync(approved) ? readFolder(approved) : null;
        if (!files || fingerprintOf(files) !== fingerprint) throw new Error("Its approved copy is missing or was changed outside the app. Switch it on again.");
        // built from the bytes that were just checked, not from the folder a second time
        const src = path.join(dir("plugins-run"), id, "src");
        writeFolder(src, files);
        const built = await build(src, out);
        if (built.id !== id) throw new Error(`Its files say its id is ${built.id}`);
        return { id, fingerprint, built, out };
      } catch (e) {
        return { id, fingerprint, out, error: message(e) };
      }
    }),
  );

  const table = new Map<string, unknown>();
  (globalThis as { __ctHost?: unknown }).__ctHost = { get: (id: string) => table.get(id) };
  const { hostModules } = await import("../plugin-host.gen");
  for (const b of builds) {
    if (!b.built) {
      failures.set(b.id, b.error!);
      continue;
    }
    try {
      if ([...compiled, ...loaded].some((p) => p.id === b.id)) throw new Error(`the app already has a plug-in called ${b.id}`);
      if (b.built.server) {
        writeState({ ...state, loading: { id: b.id, fingerprint: b.fingerprint } });
        const plugin = await Promise.race([
          (async () => {
            for (const need of b.built!.needs.server) {
              const load = hostModules[need];
              if (!load) throw new Error(`It needs ${need.replace(/^pkg:/, "the package ")}, which this version of the app doesn't have`);
              if (!table.has(need)) table.set(need, await load());
            }
            return ((await import(pathToFileURL(path.join(b.out, "server.js")).href)) as { default: ServerPlugin }).default;
          })(),
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error("It took too long to load")), LOAD_TIMEOUT_MS).unref()),
        ]);
        const problem = admissionProblem([...compiled, ...loaded], plugin, more);
        if (problem) throw new Error(problem);
        if (plugin.id !== b.id) throw new Error(`plugin.ts loaded as ${plugin.id}`);
        loaded.push(plugin);
        fromFolder.add(plugin);
      }
      if (b.built.web) {
        const css = path.join(b.out, "web.css");
        webFiles.set(b.id, { js: readFileSync(path.join(b.out, "web.js")), css: existsSync(css) ? readFileSync(css) : null });
      }
      running.set(b.id, b.built);
      console.log(`[plugins] ${b.id} loaded from the plug-ins folder`);
    } catch (e) {
      failures.set(b.id, message(e));
      console.error(`[plugins] ${b.id} was left out: ${message(e)}`);
    } finally {
      writeState({ ...state, loading: null });
    }
  }
  if (loaded.length) watchCrashes();
  return loaded;
}

/**
 * Runs a plug-in's start hook (startPlugins in lib/plugin.ts). For one from the folder, a hook that throws is recorded
 * and the server goes on, and the loading mark is up while it runs, so a hook that kills the server is named next time.
 */
export function startFolderPlugin(plugin: ServerPlugin, run: () => void): void {
  if (!fromFolder.has(plugin)) return run();
  const state = readState();
  writeState({ ...state, loading: { id: plugin.id, fingerprint: parseOn(process.env.CT_PLUGINS_ON).get(plugin.id) ?? "" } });
  try {
    run();
  } catch (e) {
    failures.set(plugin.id, `Its start failed: ${message(e)}`);
    console.error(`[plugins] ${plugin.id} start failed: ${message(e)}`);
  } finally {
    writeState({ ...readState(), loading: null });
  }
}

/** The plug-in whose built file is in an error's stack, or null. */
export function blamedPlugin(stack: string | undefined, runDir = dir("plugins-run")): string | null {
  const at = (stack ?? "").indexOf(runDir + path.sep);
  if (at < 0) return null;
  return (stack ?? "").slice(at + runDir.length + 1).split(/[/\\]/)[0] || null;
}

/**
 * An error nobody caught ends the server, as it always did. When its stack is in a folder plug-in's file, that
 * plug-in is written down first, so the restart leaves it out instead of crashing again.
 */
function watchCrashes(): void {
  if (process.env.NODE_ENV === "test") return; // a test's own failure is the test runner's to report
  const on = parseOn(process.env.CT_PLUGINS_ON);
  const die = (e: unknown) => {
    const id = blamedPlugin(e instanceof Error ? e.stack : undefined);
    if (id && on.has(id)) {
      const state = readState();
      state.stopped[id] = { fingerprint: on.get(id)!, error: `It stopped the app's server: ${message(e)}` };
      writeState(state);
    }
    console.error(e);
    process.exit(1);
  };
  process.on("uncaughtException", die);
  process.on("unhandledRejection", die);
}

/** A normal stop while a plug-in loads (the app quits) is nobody's fault: the loading mark comes down. */
export function clearLoadingMark(): void {
  if (!folderPluginsEnabled()) return;
  const state = readState();
  if (state.loading) writeState({ ...state, loading: null });
}

// ---- the list, and Switch on ----

/** The plug-in's id, name and one line as its files state them, without running anything (the builder is the authority). */
function describeFiles(files: Map<string, Buffer>): { id: string | null; name: string | null; about: string } {
  const texts = ["plugin.ts", "web.tsx"].map((f) => files.get(f)?.toString("utf8") ?? "");
  const idAt = (t: string) => /\bid:\s*"([a-z0-9][a-z0-9-]{0,39})"/.exec(t);
  const near = (key: string) => texts.map((t) => new RegExp(`\\b${key}:\\s*"([^"]+)"`).exec(t.slice(idAt(t)?.index ?? t.length).slice(0, 600))?.[1]).find(Boolean);
  return { id: texts.map((t) => idAt(t)?.[1]).find(Boolean) ?? null, name: near("name") ?? null, about: near("about") ?? "" };
}

/** Every folder in plugins/, and every plug-in that is on, as Community → Installed lists them. */
export function folderPluginRows(): FolderPluginRow[] {
  const on = parseOn(process.env.CT_PLUGINS_ON);
  const state = readState();
  const rows: FolderPluginRow[] = [];
  const seen = new Set<string>();
  const names = existsSync(dir("plugins")) ? readdirSync(dir("plugins"), { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith(".")).map((d) => d.name) : [];
  for (const folder of names.sort()) {
    const row: FolderPluginRow = { folder, id: null, name: folder, about: "", on: false, running: false, changed: false };
    try {
      const files = readFolder(path.join(dir("plugins"), folder));
      const said = describeFiles(files);
      if (!files.has("plugin.ts") && !files.has("web.tsx")) throw new Error("The folder has neither plugin.ts nor web.tsx");
      if (!said.id) throw new Error('Its files state no id (id: "lowercase-letters")');
      if (seen.has(said.id)) throw new Error(`Another folder is already the plug-in ${said.id}`);
      seen.add(said.id);
      Object.assign(row, { id: said.id, name: running.get(said.id)?.name ?? said.name ?? said.id, about: said.about });
      row.on = on.has(said.id);
      row.running = running.has(said.id);
      row.changed = row.on && fingerprintOf(files) !== on.get(said.id);
      const why = failures.get(said.id) ?? state.stopped[said.id]?.error;
      if (row.on && why) row.error = why;
    } catch (e) {
      row.error = message(e);
    }
    rows.push(row);
  }
  // on, but its folder is gone: it runs from the approved copy, and can still be switched off
  for (const id of on.keys()) {
    if (seen.has(id)) continue;
    const built = running.get(id);
    rows.push({ folder: "", id, name: built?.name ?? id, about: built?.about ?? "", on: true, running: !!built, changed: false, error: failures.get(id) ?? state.stopped[id]?.error });
  }
  return rows;
}

export interface Prepared {
  id: string;
  name: string;
  about: string;
  fingerprint: string;
  /** It has a server half: it runs on this Mac with the app's access. */
  server: boolean;
  web: boolean;
}

/**
 * Switch on, step one (the Mac app asks, then shows its own dialog): takes a copy of the folder as it is now, builds
 * that copy to see that it builds, and answers with the copy's fingerprint. Nothing of the plug-in runs. Throws with
 * what is wrong. The copy is what will run once the person agrees, whatever happens to the folder afterwards.
 */
export async function prepareFolderPlugin(folder: string): Promise<Prepared> {
  if (!/^[^./\\][^/\\]*$/.test(folder)) throw new Error("Not a plug-in folder");
  const live = path.join(dir("plugins"), folder);
  if (!existsSync(live) || !statSync(live).isDirectory()) throw new Error("The folder is gone");
  const files = readFolder(live);
  const fingerprint = fingerprintOf(files);
  const scratch = path.join(dir("plugins-approved"), `.new-${randomUUID()}`);
  try {
    writeFolder(path.join(scratch, "src"), files);
    const built = await build(path.join(scratch, "src"), path.join(scratch, "out"));
    const home = path.join(dir("plugins-approved"), built.id);
    // keep the copy that is on now and this one; older tries go
    const keep = new Set([fingerprint, parseOn(process.env.CT_PLUGINS_ON).get(built.id)]);
    if (existsSync(home)) for (const old of readdirSync(home)) if (!keep.has(old)) rmSync(path.join(home, old), { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    rmSync(path.join(home, fingerprint), { recursive: true, force: true });
    renameSync(path.join(scratch, "src"), path.join(home, fingerprint));
    return { id: built.id, name: built.name, about: built.about, fingerprint, server: built.server, web: built.web };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The routes: the list and Switch on's first step for the admin, and the page halves for the app's own page.
 * All under /api, so behind the login like every other route.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mountFolderPlugins(app: Hono<any, any, any>): void {
  const admin = (c: { get: (k: "user") => unknown }) => (c.get("user") as { role?: string } | undefined)?.role === "admin";
  app.get("/api/plugins/folder", (c) => {
    if (!folderPluginsEnabled() || !admin(c)) return c.json({ enabled: false, paused: false, folder: "", rows: [] });
    return c.json({ enabled: true, paused: paused(), folder: dir("plugins"), rows: folderPluginRows() });
  });
  app.post("/api/plugins/folder/:name/prepare", async (c) => {
    if (!folderPluginsEnabled() || !admin(c)) return c.json({ error: "Plug-ins are switched on in the Creator Toolset Mac app, on the Mac that runs it." }, 403);
    try {
      return c.json(await prepareFolderPlugin(c.req.param("name")));
    } catch (e) {
      return c.json({ error: message(e) }, 400);
    }
  });
  app.get("/api/plugins/web", (c) => c.json({ plugins: [...webFiles.keys()].map((id) => ({ id, name: running.get(id)!.name, css: !!webFiles.get(id)!.css, needs: running.get(id)!.needs.web })) }));
  app.get("/api/plugins/web/:id/:file{web\\.(js|css)}", (c) => {
    const files = webFiles.get(c.req.param("id"));
    const body = c.req.param("file") === "web.js" ? files?.js : files?.css;
    if (!body) return c.json({ error: "Not Found" }, 404);
    return c.body(new Uint8Array(body), 200, { "Content-Type": c.req.param("file") === "web.js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "Cache-Control": "no-cache" });
  });
}

/** Under tests: forget what a start loaded. */
export function resetFolderPluginsForTest(): void {
  running.clear();
  webFiles.clear();
  failures.clear();
  fromFolder.clear();
}
