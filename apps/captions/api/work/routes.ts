/**
 * Item 4B: the work package's routes for a computer's worker (contracts/work.ts), mounted at /api/devices/relay/work
 * before the relay mount (api/devices.ts), with the device's ctd_ token. Every call keeps the computer online.
 */
import { Hono, type Context } from "hono";
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { parseMachine, type Device } from "../../contracts/providers";
import { WORK_MIN, type MadeProxy, type WorkClaim, type WorkResult } from "../../contracts/work";
import { beatForDevice, claimForComputer, failForDevice } from "../editor/worker";
import { spending } from "../editor/store";
import { deviceForToken, deviceOf, noteMachine, setDeviceWork, touchDevice } from "../lib/devices";
import { onLeave } from "../lib/sync";
import { libraryDb } from "../library/db";
import { noteProxyCache } from "../library/places";
import { libraryMedia } from "../library/routes";
import { finishJob, type JobRow } from "../library/jobs";
import { claimExtras, offlineFor } from "./offline";
import { claimLibraryForComputer, libWorkApp } from "./library-package";
import { claimPictures, picturesWorkApp } from "./pictures";
import { claimTask, taskWorkApp } from "./tasks";
import { buildPackage, ownFile } from "./package";
import { noteProgress, parseBeat } from "./place";
import { acceptUpload, applyResult } from "./result";
import { serveAi, serveCall } from "./serve";

/** The most one result file may weigh (a preview, a generated clip, a cache file). */
const FILE_MAX = 8 * 1024 ** 3;

/** How long a claim is held when nothing waits, and how often it looks again meanwhile. Tests shorten it. */
export const CLAIM_POLL = { holdMs: 25_000, everyMs: 2000 };

/** The device behind the ctd_ token; it is alive. */
function caller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id, c.req.header("user-agent"));
  return d;
}
const idOf = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
/** The step `device` holds (claimed by it, still running), else undefined. */
const held = (id: number, device: string): JobRow | undefined =>
  libraryDb().prepare("SELECT * FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(id, device) as JobRow | undefined;

const strings = (v: unknown, max: number): string[] | null =>
  Array.isArray(v) && v.length <= max && v.every((x) => typeof x === "string" && x.length <= 100) ? (v as string[]) : null;

/** A cache report's `made` (contracts/work.ts MadeProxy): each a size or a skip, at most 20 000; anything else is none. */
function madeOf(v: unknown): Record<string, MadeProxy> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, MadeProxy> = {};
  for (const [id, m] of Object.entries(v as Record<string, unknown>).slice(0, 20_000)) {
    const x = (m ?? {}) as Record<string, unknown>;
    if (id.length > 100) continue;
    if (x.skip === true) out[id] = { skip: true };
    else if (Number.isSafeInteger(x.w) && Number.isSafeInteger(x.h) && (x.w as number) > 0 && (x.h as number) > 0) out[id] = { w: x.w as number, h: x.h as number };
  }
  return out;
}

export const workApp = new Hono();

// library jobs (phase 6): their own ids, under work/lib/:id/
workApp.route("/lib", libWorkApp);
workApp.route("/pictures", picturesWorkApp);
// computer tasks (local-first P3): their own ids, under work/task/:id/
workApp.route("/task", taskWorkApp);

workApp.post("/claim", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const v = b?.v;
  const steps = strings(b?.steps ?? [], 50);
  if (typeof v !== "number" || !Number.isSafeInteger(v) || !steps) return c.json({ error: "v: a number, steps: a list of step ids" }, 400);
  const raw = b?.cache && typeof b.cache === "object" ? (b.cache as Record<string, unknown>) : null;
  const cache = raw && typeof raw.bytes === "number" && raw.bytes >= 0
    ? {
        bytes: raw.bytes,
        ...(typeof raw.limit === "number" ? { limit: raw.limit } : {}),
        ...(strings(raw.offline, 20_000) ? { offline: raw.offline as string[] } : {}),
        ...(strings(raw.versions, 20_000) ? { versions: raw.versions as string[] } : {}),
        // where its cache is on that computer: a plug-in's proxy plays from there (lib/plugin.ts computerProxies)
        ...(typeof raw.dir === "string" && raw.dir.startsWith("/") && raw.dir.length <= 1024 ? { dir: raw.dir } : {}),
        ...(madeOf(raw.made) ? { made: madeOf(raw.made)! } : {}),
      }
    : undefined;
  // its unfinished downloads: asked about with the versions, never counted as held
  const parts = (cache && strings(raw?.parts, 1000)) || [];
  // a worker that runs library jobs says so: one that doesn't is never handed one
  const library = b?.library === true;
  const pictures = b?.pictures === true;
  // a worker that takes only library jobs (CT_WORKER_KINDS=library) is never handed an editor step
  const libraryOnly = library && b?.libraryOnly === true;
  // the computer task kinds it runs (tasks.ts): one that names none is never handed a task
  const tasks = strings(b?.tasks ?? [], 100) ?? [];
  // the library job kinds it runs beyond the first ones (work/library-package.ts LATER_KINDS): an older one names none
  const libraryKinds = (library && strings(b?.libraryKinds ?? [], 50)) || [];
  // its load and shares now: load balancing scores it, and a share it has connected gives it the folders on it
  const machine = parseMachine(b?.machine);
  if (machine) noteMachine(d.id, machine);
  const prev = deviceOf(d.id)?.work;
  const now = Date.now();
  // Empty, the proxies kept offline and the cached ones to delete go with every answer (api/work/offline.ts)
  const answer = async (claim: WorkClaim) => c.json({ ...claim, account: d.owner, ...(await claimExtras(d.id, cache?.offline, [...(cache?.versions ?? []), ...parts])) } satisfies WorkClaim);
  // a library worker short of disk says so once a minute: noted on its row, and nothing else (no `at`, so it is no fresh
  // taker and outranks no other computer for the jobs it can't take now); the next claim without it drops the mark
  if (b?.lowDisk === true) {
    setDeviceWork(d.id, { v, steps, ...prev, lowDisk: true, lowDiskAt: now });
    return c.json({ pkg: null } satisfies WorkClaim);
  }
  // a package version this server found too old stays on the row until a claim comes with a newer one (work.tooOld)
  const tooOld = prev?.tooOld !== undefined && v <= prev.tooOld ? prev.tooOld : undefined;
  // told to update before anything is stamped: a worker restarted every 30 s is never a fresh peer
  if (v < WORK_MIN || (libraryOnly && tooOld !== undefined)) {
    const { lowDisk: _l, lowDiskAt: _a, ...was } = prev ?? { steps };
    setDeviceWork(d.id, { ...was, v, tooOld: tooOld ?? v });
    return answer({ pkg: null, update: true });
  }
  // kept apart from the runner's kinds. An Empty not told yet stays, and the cache it will empty counts as emptied
  const empty = prev?.empty;
  // no report (a worker's first claim, before it knows whose cache it is): the device's last one stands, the same account's
  const kept = cache ?? prev?.cache;
  setDeviceWork(d.id, {
    v,
    steps,
    ...(kept ? { cache: empty ? { ...kept, bytes: 0, versions: [] } : kept } : {}),
    ...(empty ? { empty } : {}),
    ...(library ? { library: true as const } : {}),
    ...(libraryKinds.length ? { libraryKinds } : {}),
    ...(pictures && !libraryOnly ? { pictures: true as const } : {}),
    ...(libraryOnly ? { libraryOnly: true as const } : {}),
    ...(tasks.length && !libraryOnly ? { tasks } : {}),
    // it declares each proxy's SHA-256 before sending it (library/upload-gate.ts provesProxies)
    ...(library && b?.proof === true ? { proof: true as const } : {}),
    // a library claim of a current package: what makes this computer a library taker (library-package.ts takesLibrary)
    ...(library && tooOld === undefined ? { libraryAt: now } : {}),
    // too old for library packages only: its editor steps still come
    ...(tooOld !== undefined ? { tooOld } : {}),
    at: now,
  });
  // the cache it reported is its proxy places (version_places kind 'proxy'): what "On this computer" and Locate read
  if (cache?.versions || empty) noteProxyCache(d.id, empty ? [] : (cache?.versions ?? []));
  const end = Date.now() + CLAIM_POLL.holdMs;
  let gone = false; // a reload (lib/sync.ts leave): the poll answers "nothing" now, and the computer asks the next process
  for (;;) {
    const got = libraryOnly ? null : await claimForComputer(deviceOf(d.id)!);
    if (got) {
      try {
        const pkg = await buildPackage(got.job, d);
        return answer({ pkg: got.gate === undefined ? pkg : { ...pkg, gate: got.gate } });
      } catch (e) {
        // a package the server could not build: a failed try (retried after its backoff), never a held step nobody runs
        libraryDb().prepare("UPDATE edit_jobs SET device = NULL WHERE id = ?").run(got.job.id);
        finishJob(libraryDb(), got.job.id, false, e instanceof Error ? e.message : String(e), Date.now(), "edit_jobs");
        continue;
      }
    }
    const lib = library ? await claimLibraryForComputer(deviceOf(d.id)!) : null;
    if (lib) return answer({ pkg: null, lib });
    const pics = libraryOnly ? null : await claimPictures(deviceOf(d.id)!);
    if (pics) return answer({ pkg: null, pics });
    const task = libraryOnly ? null : claimTask(deviceOf(d.id)!);
    if (task) return answer({ pkg: null, task });
    if (Date.now() >= end || gone || c.req.raw.signal.aborted || deviceOf(d.id)?.work?.empty) return answer({ pkg: null });
    let off = () => {};
    await new Promise<void>((r) => {
      setTimeout(r, Math.min(CLAIM_POLL.everyMs, Math.max(0, end - Date.now())));
      off = onLeave(() => ((gone = true), r()));
    });
    off();
    touchDevice(d.id, c.req.header("user-agent"));
  }
});

/** A proxy the computer keeps offline (offline.ts offlineFor): only one its owner set offline and may see, never the original. */
workApp.get("/offline/:version", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const version = c.req.param("version");
  if (!(await offlineFor(d)).some((f) => f.id === version)) return c.json({ error: "Not found" }, 404);
  return libraryMedia(c, d.owner, version, "proxy");
});

/** The original of a file the computer keeps offline (Originals downloads, a library that hosts them): never another. */
workApp.get("/offline/:version/original", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const version = c.req.param("version");
  if (!(await offlineFor(d)).some((f) => f.id === version && f.kind === "original")) return c.json({ error: "Not found" }, 404);
  return libraryMedia(c, d.owner, version, "source");
});

workApp.post("/:id/beat", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const id = idOf(c);
  const ok = beatForDevice(d.id, id);
  if (ok) noteProgress(id, d, parseBeat(await c.req.json().catch(() => null)));
  return c.json({ ok });
});

/** The AI call and the server reads of a held step: run as the step's account (api/work/serve.ts). */
workApp.post("/:id/ai", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = held(idOf(c), d.id);
  if (!job) return c.json({ error: "Not found" }, 404);
  const b = await c.req.json().catch(() => null);
  // the step's spend, as a step on the server adds it up (editor/store.ts spending)
  return c.json((await spending(job, () => serveAi(job, b))) ?? null);
});
workApp.post("/:id/call", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const job = held(idOf(c), d.id);
  if (!job) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (typeof b?.fn !== "string") return c.json({ error: "fn: a name" }, 400);
  try {
    return c.json((await spending(job, () => serveCall(job, b.fn as string, Array.isArray(b.args) ? b.args : []))) ?? null);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
});

workApp.get("/:id/own", (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const id = idOf(c);
  const file = held(id, d.id) && ownFile(id, c.req.query("path") ?? "");
  return file ? new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "content-type": "application/octet-stream" } }) : c.json({ error: "Not found" }, 404);
});

workApp.put("/:id/file", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const id = idOf(c);
  if (!held(id, d.id)) return c.json({ error: "Not found" }, 404);
  if (Number(c.req.header("content-length") ?? NaN) > FILE_MAX) return c.json({ error: "The file is too big." }, 413);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Send the file." }, 400);
  const ok = await acceptUpload(id, d.id, c.req.query("path") ?? "", Readable.fromWeb(body as never));
  return ok ? c.json({ ok }) : c.json({ error: "Not a file this step may send" }, 400);
});

workApp.post("/:id/done", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const r = (await c.req.json().catch(() => null)) as WorkResult | null;
  if (!r || typeof r !== "object" || !r.outcome || !r.edit) return c.json({ error: "A work result" }, 400);
  return c.json({ ok: await applyResult(idOf(c), d.id, r) });
});

/** The step could not run on this computer (a crash too): a counted try, retried after its backoff. */
workApp.post("/:id/fail", async (c) => {
  const d = caller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json({ ok: failForDevice(d.id, idOf(c), typeof b?.error === "string" && b.error ? b.error : "Your computer could not run this step") });
});
