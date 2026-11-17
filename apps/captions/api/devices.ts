import { Hono, type Context } from "hono";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import { LOAD_PREFERENCES, type Device } from "../contracts/providers";
import { COPY_KIND, CUTOUT_KIND, FOLDER_LIST_KIND, HELPER_CHECK_KIND, LIBRARY_LOOK_KIND, parseKinds, parseModels, RESOLVE_KIND, SPLIT_KIND, TRANSCRIBE_KIND, type DeviceClaim, type DeviceHint } from "../contracts/devices";
import { clientAddress, phoneOrigin, type AuthVars } from "./auth";
import { claimableBy, usesFootage } from "./editor/engine";
import { fitsFor, footageFor, heldCopy } from "./editor/reach";
import { serveBlob } from "./library/routes";
import { cardsDraw, saveCard } from "./editor/cards/device";
import { beatForDevice, claimForDevice, doneForDevice, failForDevice, waitsForDevice } from "./editor/worker";
import { mayClaim, offOf, readBalance, writeBalance, type WorkerSeen } from "./lib/balance";
import { claimTranscript, declareModels, heldAudio, heldProxy, isComputerModel, modelsOutOfStep, transcriptFailed, transcriptSent, transcriptWaits } from "./lib/computer-transcribe";
import { claimCutout, cutoutFailed, cutoutSent, cutoutWaits, heldCutout } from "./lib/cutouts";
import { relayRoutes } from "./lib/mac-claude";
import { deviceOf, deviceForToken, forViewer, isOnline, listDevices, mintPairCode, moveProviders, pairDevice, pairWithCode, renameDevice, revokeDevice, setDeviceKinds, setDeviceWork, touchDevice } from "./lib/devices";
import { clearTries, waitFor, wrongTry } from "./lib/sign-in-code";
import { findUser } from "./users";
import { resolveGranted } from "./lib/packs";
import { storageApp } from "./devices-storage";
import { pluginDeviceJobs } from "./lib/plugin";
import { folderListJob } from "./lib/folder-list";
import { checkComputer, helperCheckJob } from "./lib/helper-check";
import { lookSheetsClaim, macLookJob } from "./library/mac-look";
import { copyFile, copyJob } from "./library/copies";
import { env } from "./lib/env";
import { workWaits } from "./work/place";
import { SERVER_PLACE } from "./work/server-work";
import { workApp } from "./work/routes";

/**
 * The Macs that run AI jobs (lib/devices.ts). Routes (boot.ts mounts them at /api/devices):
 *   POST /api/devices body {name, version?} → {device, token}   pair this account's Mac (the token is shown once)
 *   POST /api/devices/code → {code, expiresAt, url}              a one-time code for a computer with no browser (apps/helper)
 *   POST /api/devices/pair {code, name, version?} → {device, token}   that computer swaps it (devicePairApp, before the account gate)
 *   GET /api/devices → Array<Device & {online}>                  own; admins also the workspace's and admins' Macs
 *   PATCH /api/devices/:id {name}                                owner or admin
 *   DELETE /api/devices/:id                                      owner or admin
 *   POST /api/devices/relay/editor/claim {kinds}                 the device declares its editor step kinds and takes one (contracts/devices.ts)
 *   POST /api/devices/relay/editor/job/:id/beat | /done | /fail  the device's step, same token
 *   GET /api/devices/relay/editor/job/:id/cards, POST …/cards/:cardId   a cards-draw step: what to draw, and each card drawn
 *   GET /api/devices/relay/cutout/:id, POST …/cutout/:id | …/cutout/:id/fail   a cut-out (lib/cutouts.ts): the picture, its PNG or why not
 *   GET /api/devices/relay/job/:kind/:id, POST …/:id | …/:id/file | …/:id/fail   a plug-in's job (lib/plugin.ts DeviceJobSlot)
 *   GET /api/devices/relay/transcribe/:id, POST …/transcribe/:id | …/:id/fail   a transcript (lib/computer-transcribe.ts): the audio, the words or why not
 *   /api/devices/relay/work/…                                    a computer's work package worker (api/work/routes.ts, contracts/work.ts)
 *   POST /api/devices/relay/wait | /report | /:id/text | /:id/step | /:id/done | /:id/fail
 *       (a /wait that lists `editor` kinds is answered { editor: true } when a step of one waits, { work: true } when a
 *       work package step waits for it: contracts/devices.ts)
 *       the Mac app's side, Authorization: Bearer ctd_… (boot.ts checks it before the cookie gate); the same bodies
 *       as the relay routes in mac-claude.ts (relayRoutes)
 */

export const devicesApp = new Hono<{ Variables: AuthVars }>();

/**
 * The jobs on the device job road: the app's own folder listing (lib/folder-list.ts), computer check
 * (lib/helper-check.ts), shot descriptions of a file on a Mac (library/mac-look.ts) and the Media Library's copies
 * (library/copies.ts), then each plug-in's.
 */
const deviceJobs = () => [folderListJob, helperCheckJob, macLookJob, copyJob, ...pluginDeviceJobs()];

/** The device behind a ctd_ token on an editor route; a 401 when there is none. Keeps the device here (it is alive). */
function deviceCaller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id, c.req.header("user-agent"));
  return d;
}
/** A job id from the path; anything that is not a positive integer matches no job. */
const jobId = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// registered before the relay mount below, so these answer first (the relay's middleware is for its own routes)
devicesApp.post("/relay/editor/claim", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const kinds = parseKinds(b?.kinds);
  if (!kinds) return c.json({ error: "kinds: a list of step kinds" }, 400);
  const held = parseModels(b?.models, isComputerModel);
  const getting = parseModels(b?.getting, isComputerModel);
  const asked = parseModels(b?.asked, isComputerModel);
  // a Mac says which models it has loaded (a recording someone waits on goes only to one that has: `servesSoon`)
  const ready = b?.ready === undefined ? undefined : parseModels(b.ready, isComputerModel);
  if (!held || !getting || !asked || ready === null) return c.json({ error: "models, getting, asked, ready: lists of model ids" }, 400);
  const k = await declared(d, kinds);
  // the shot description sheets it keeps: counted, and the ones to drop named (library/mac-look.ts)
  const looks = lookSheetsClaim(d, b?.looks);
  const sheets = looks ? { looks } : {};
  if (!k.includes(TRANSCRIBE_KIND)) return c.json({ job: claimCutout(d, k) ?? claimPluginJob(d, k) ?? (await editorStep(d, k)), ...sheets } satisfies DeviceClaim);
  // a computer that runs speech models: what it has now, its transcript if one waits for it, and what its owner wants on it
  declareModels(d, held, getting, asked, ready);
  const now = deviceOf(d.id)!;
  const job = claimCutout(now, k) ?? claimPluginJob(now, k) ?? claimTranscript(now, await readBalance(d.owner)) ?? (await editorStep(now, k));
  return c.json({ job, models: deviceOf(d.id)!.stt!.want, ...sheets } satisfies DeviceClaim);
});
/** An AI Editor step for the device, if one waits for it: a step that reads footage carries where its files are for it. */
async function editorStep(d: Device, kinds: string[]) {
  const job = await claimForDevice(d, kinds, Date.now(), await fitsFor(d));
  return job && usesFootage(job.kind) ? { ...job, footage: await footageFor(d, job.editId) } : job;
}
/** The kinds a device lists (its claim, or its long poll), kept as its own, and the ones of them it may take now. */
async function declared(d: Device, kinds: string[]): Promise<string[]> {
  // what the device runs is stored with it, so Settings → Devices can show it; a claim with none claims nothing
  // the Resolve bridge is switched on by a pack with Resolve items (the owner's Resolve plug-in or a downloaded one)
  const granted = kinds.includes(RESOLVE_KIND) && (await resolveGranted(d.owner));
  const plugin = new Set(deviceJobs().map((j) => j.kind));
  const claimable = [...claimableBy(kinds).filter((k) => k !== RESOLVE_KIND || granted), ...kinds.filter((k) => k === CUTOUT_KIND || k === SPLIT_KIND || k === TRANSCRIBE_KIND || plugin.has(k))];
  setDeviceKinds(d.id, claimable);
  return balancedKinds(d, claimable);
}
/**
 * The device's long poll lists the editor kinds it would claim right now (`editor`, contracts/devices.ts): they are kept
 * as the claim keeps them, and true says a claim made now would be handed a step, so the poll is answered with the hint.
 * A list that is no list of kinds is read as none sent.
 */
async function editorWaits(device: string, listed: unknown, workV?: unknown): Promise<DeviceHint | null> {
  const d = deviceOf(device);
  if (!d) return null;
  // `work`: the package version this computer's worker runs (contracts/work.ts WORK_V). Kept with the device before its
  // worker ever claimed, so a computer that never ran one is told when a step waits for it and starts it. Its worker
  // takes Media Library jobs too (computer.ts claims with library: true), so it counts as a library taker from here:
  // without that, a Mac that never claimed is never told a library job waits for it (library-package.ts takesLibrary)
  if (typeof workV === "number") setDeviceWork(d.id, { ...(d.work ?? { steps: [] }), v: Math.max(workV, d.work?.v ?? 0), library: true });
  const kinds = parseKinds(listed);
  const editor = kinds ? await waits(d, await declared(d, kinds)) : false;
  // a core step placed on a computer: the app starts its worker, which claims it through work/claim
  const work = await workWaits(deviceOf(device) ?? d);
  return editor || work ? { ...(editor ? { editor: true as const } : {}), ...(work ? { work: true as const } : {}) } : null;
}
/**
 * Whether a step of one of these kinds waits for this device: an edit's (editor/worker.ts), a cut-out (lib/cutouts.ts),
 * or a transcript it would be handed (lib/computer-transcribe.ts); a computer whose wanted speech models changed is told too.
 */
const waits = async (d: Device, kinds: string[]) =>
  waitsForDevice(d.owner, kinds, Date.now(), await fitsFor(d)) || cutoutWaits(d.owner, kinds) || deviceJobs().some((j) => kinds.includes(j.kind) && j.waits(d.owner, d.id)) ||
  (kinds.includes(TRANSCRIBE_KIND) && (modelsOutOfStep(d) || transcriptWaits(d, await readBalance(d.owner))));
/** A plug-in's job of one of these kinds for this device (ServerPlugin.deviceJobs), now its own; null when none waits. */
function claimPluginJob(d: { id: string; owner: string }, kinds: string[]): ReturnType<typeof claimCutout> {
  for (const j of deviceJobs()) if (kinds.includes(j.kind)) {
    const job = j.claim(d);
    if (job) return job;
  }
  return null;
}
/** The answer to done and fail: `editor: true` when another step this device could claim waits, so it claims at once. */
const ended = async (d: Device, ok: boolean) => ({ ok, ...(ok && (await waits(d, await balancedKinds(d, d.kinds ?? []))) ? { editor: true } : {}) });
devicesApp.post("/relay/editor/job/:id/beat", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: beatForDevice(d.id, jobId(c)) });
});
devicesApp.post("/relay/editor/job/:id/done", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  return c.json(await ended(d, doneForDevice(d.id, jobId(c))));
});
devicesApp.post("/relay/editor/job/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const why = typeof b?.error === "string" && b.error ? b.error : "The device could not run this step";
  return c.json(await ended(d, failForDevice(d.id, jobId(c), why)));
});
// a step's file from the server's copy (contracts/devices.ts DeviceFootage `copy`): only to the device that holds the step,
// and only what the server already keeps (nothing is uploaded for it): its proxy; the original only when asked for and
// the library uploads originals (editor/reach.ts heldCopy)
devicesApp.get("/relay/editor/job/:id/footage/:version", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const key = heldCopy(d.id, jobId(c), c.req.param("version"), c.req.query("original") === "1");
  return key ? serveBlob(c, key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});
// a cards-draw step (contracts/devices.ts): what the Mac that holds it is to draw, and each card it drew
devicesApp.get("/relay/editor/job/:id/cards", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const draw = cardsDraw(d.id, jobId(c));
  return draw ? c.json(draw) : c.json({ error: "Not found" }, 404);
});
devicesApp.post("/relay/editor/job/:id/cards/:cardId", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const form = await c.req.parseBody({ all: true }).catch(() => ({}) as Record<string, unknown>);
  const wrong = await saveCard(d.id, jobId(c), c.req.param("cardId"), form.clip, form.still);
  return wrong ? c.json({ error: wrong }, wrong === "Not found" ? 404 : 400) : c.json({ ok: true });
});

// a cut-out or a split (contracts/devices.ts CUTOUT_KIND, SPLIT_KIND): the picture, and what the Mac made of it or why it could not
devicesApp.get("/relay/cutout/:id", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const cut = heldCutout(d.id, jobId(c));
  return cut ? c.body(new Uint8Array(cut.picture), 200, { "content-type": cut.mime }) : c.json({ error: "Not found" }, 404);
});
devicesApp.post("/relay/cutout/:id", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const sent: Record<string, Buffer | string> = {};
  for (const [k, v] of Object.entries(form)) if (v instanceof File) sent[k] = Buffer.from(await v.arrayBuffer());
  else if (typeof v === "string") sent[k] = v;
  const wrong = cutoutSent(d.id, jobId(c), sent);
  return wrong ? c.json({ error: wrong }, wrong === "Not found" ? 404 : 400) : c.json(await ended(d, true));
});
devicesApp.post("/relay/cutout/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json(await ended(d, cutoutFailed(d.id, jobId(c), typeof b?.error === "string" && b.error ? b.error : "Your Mac could not cut the picture out.")));
});

// a plug-in's job (lib/plugin.ts DeviceJobSlot): its input, the device's answers, a file it made, or why it could not
const slotOf = (c: Context) => deviceJobs().find((j) => j.kind === c.req.param("kind"));
/** The most a file a device sends for a plug-in's job may weigh. */
export const DEVICE_FILE_MAX = 8 * 1024 ** 3;
devicesApp.get("/relay/job/:kind/:id", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const input = await slotOf(c)?.input(d.id, jobId(c));
  return input ? new Response(Readable.toWeb(createReadStream(input.file)) as ReadableStream, { headers: { "content-type": input.type } }) : c.json({ error: "Not found" }, 404);
});
// a copy's file (library/copies.ts): the stored original, Range allowed, only to the computer that holds the job
devicesApp.get(`/relay/job/${COPY_KIND}/:id/file`, async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const f = await copyFile(d.id, jobId(c));
  if (!f) return c.json({ error: "Not found" }, 404);
  if ("key" in f) return serveBlob(c, f.key, "application/octet-stream");
  return (await f.open(c.req.raw)) ?? c.json({ error: "Not found" }, 404);
});
devicesApp.post("/relay/job/:kind/:id", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const slot = slotOf(c);
  if (!slot) return c.json({ error: "Not found" }, 404);
  const r = await slot.answer(d.id, jobId(c), await c.req.json().catch(() => null));
  return "error" in r ? c.json({ error: r.error }, r.status as 400) : c.json({ ...(r.reply as object), ...(await ended(d, true)) });
});
devicesApp.post("/relay/job/:kind/:id/file", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const slot = slotOf(c);
  if (!slot) return c.json({ error: "Not found" }, 404);
  if (Number(c.req.header("content-length") ?? NaN) > DEVICE_FILE_MAX) return c.json({ error: "The file is too big." }, 413);
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "Send the file." }, 400);
  const dir = path.join(env.dataDir, "devices", "incoming");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, randomUUID());
  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(file, { mode: 0o600 }));
    const r = await slot.file(d.id, jobId(c), file, (c.req.query("name") ?? "").slice(0, 200));
    return "error" in r ? c.json({ error: r.error }, r.status as 400) : c.json({ ...(r.reply as object), ...(await ended(d, true)) });
  } finally {
    await rm(file, { force: true });
  }
});
devicesApp.post("/relay/job/:kind/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const why = typeof b?.error === "string" && b.error ? b.error.slice(0, 500) : "Your Mac could not do it.";
  return c.json(await ended(d, slotOf(c)?.fail(d.id, jobId(c), why) ?? false));
});

// a transcript (contracts/devices.ts TRANSCRIBE_KIND): the audio, and the words the computer heard or why it could not
devicesApp.get("/relay/transcribe/:id", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  let file: string | null;
  try {
    file = await heldAudio(d.id, jobId(c));
  } catch (e) {
    return c.json({ error: `The sound could not be read: ${e instanceof Error ? e.message : e}`.slice(0, 500) }, 500);
  }
  return file ? new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "content-type": "audio/wav" } }) : c.json({ error: "Not found" }, 404);
});
// a library file's transcript: the server's proxy, for a computer that cuts the sound itself and has no copy of its own
devicesApp.get("/relay/transcribe/:id/proxy", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const key = heldProxy(d.id, jobId(c));
  return key ? serveBlob(c, key, "application/octet-stream") : c.json({ error: "Not found" }, 404);
});
devicesApp.post("/relay/transcribe/:id", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const wrong = transcriptSent(d.id, jobId(c), await c.req.json().catch(() => null));
  return wrong ? c.json({ error: wrong }, wrong === "Not found" ? 404 : 400) : c.json(await ended(d, true));
});
devicesApp.post("/relay/transcribe/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json(await ended(d, transcriptFailed(d.id, jobId(c), typeof b?.error === "string" && b.error ? b.error : "Your computer could not transcribe it.")));
});

devicesApp.route("/relay/work", workApp);
devicesApp.route("/relay", relayRoutes((c) => deviceForToken(c.req.header("authorization"))?.id ?? null, editorWaits));
devicesApp.route("/storage", storageApp);

/** Load balancing (Settings → Devices, lib/balance.ts readBalance): each person's own computers, and the server (SERVER_PLACE). */
const ALLOWED_WEIGHTS = new Set<number>(LOAD_PREFERENCES.map((x) => x.value));

devicesApp.get("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  return c.json(await readBalance(u.username));
});

devicesApp.put("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cur = await readBalance(u.username);
  if (typeof b?.on === "boolean") cur.on = b.on;
  if (b?.weights && typeof b.weights === "object") {
    for (const [id, v] of Object.entries(b.weights as Record<string, unknown>)) {
      if ((id !== SERVER_PLACE && deviceOf(id)?.owner !== u.username) || typeof v !== "number" || !ALLOWED_WEIGHTS.has(v)) return c.json({ error: `Bad weight for ${id}` }, 400);
      cur.weights[id] = v;
    }
  }
  const mine = (id: string) => deviceOf(id)?.owner === u.username;
  // the libraries a computer takes Media Library work of (null: every library), and whether it may download originals
  if (b?.libraries && typeof b.libraries === "object") {
    for (const [id, v] of Object.entries(b.libraries as Record<string, unknown>)) {
      const ok = v === null || (Array.isArray(v) && v.length <= 500 && v.every((x) => typeof x === "string" && /^[\w-]{1,100}$/.test(x)));
      if (!mine(id) || !ok) return c.json({ error: `Bad libraries for ${id}` }, 400);
      cur.libraries ??= {};
      if (v === null) delete cur.libraries[id];
      else cur.libraries[id] = [...new Set(v as string[])];
    }
  }
  if (b?.originals && typeof b.originals === "object") {
    for (const [id, v] of Object.entries(b.originals as Record<string, unknown>)) {
      if (!mine(id) || typeof v !== "boolean") return c.json({ error: `Bad originals for ${id}` }, 400);
      (cur.originals ??= {})[id] = v;
    }
  }
  await writeBalance(u.username, cur);
  return c.json(cur);
});


/**
 * POST /api/devices/:id/check {test?} → { check?, weight? }: the computer reads its disks again now (a shared drive
 * connected a moment ago counts at once); a test also reads a file in each folder it reaches and times an encode
 * (lib/helper-check.ts). For an admin a test sets the computer's load balancing weight from the result and turns load
 * balancing on, so the weight counts.
 */
devicesApp.post("/:id/check", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const d = manageable(u, c.req.param("id"));
  if (!d) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  try {
    const out = await checkComputer(d.owner, d.id, b?.test === true);
    if (out.weight !== undefined && u.role === "admin" && d.owner === u.username) {
      const cur = await readBalance(u.username);
      cur.on = true;
      cur.weights[d.id] = out.weight;
      await writeBalance(u.username, cur);
    }
    return c.json(out);
  } catch (e) {
    return c.json({ error: (e as Error).message }, 409);
  }
});

/** The same window as isOnline (lib/devices.ts): a computer that has not been heard from in 40 s is not a candidate. */
const ONLINE_MS = 40_000;
/**
 * The kinds `d` may take now under load balancing (lib/balance.ts): a kind goes to the best free computer among the
 * account's own. One computer (or balancing off) takes all of them.
 */
async function balancedKinds(d: Device, kinds: string[]): Promise<string[]> {
  const own = listDevices((x) => x.owner === d.owner);
  // one computer takes all of them, unless it is set to Off (Off is off, even alone)
  if (own.length < 2 && !offOf(d.owner).has(d.id)) return kinds;
  const now = Date.now();
  const workers: WorkerSeen[] = own
    .filter((x) => x.report?.machine)
    .map((x) => ({
      host: x.id,
      at: x.id === d.id ? now : x.lastSeen ?? 0,
      machine: x.report!.machine,
      never: kinds.filter((k) => !(x.kinds ?? []).includes(k)),
    }));
  const balance = await readBalance(d.owner);
  // a transcript picks its computer itself (lib/computer-transcribe.ts strongest: by the model it has and its graphics card),
  // a folder listing goes to the computer that holds it, a look is placed per file (library/mac-look.ts placedOn), a check to the computer checked (even one set to Off), and a step that reads footage is balanced per step among
  // the computers that get at its files (editor/reach.ts fitsFor): by kind, a stronger computer without the files would
  // hold it back from every one that has them
  return kinds.filter((k) => k === TRANSCRIBE_KIND || k === FOLDER_LIST_KIND || k === HELPER_CHECK_KIND || k === LIBRARY_LOOK_KIND || k === COPY_KIND || usesFootage(k) || mayClaim(k, d.id, workers, balance, now, ONLINE_MS));
}

/** Accounts only: not a share-link visitor. */
const signedIn = (u: AuthVars["user"]) => u.role !== "visitor";
/** Names the workspace's scope uses (usage keys, the workspace's Mac owner): no account may take them. */
const RESERVED = new Set(["workspace"]);
const online = (d: Device) => ({ ...d, online: isOnline(d.id) });
/** Admins' Macs are listed to admins: the owner's role decides (the owner may have been demoted since). */
const isAdminOwner = (owner: string) => findUser(owner)?.role === "admin";

devicesApp.post("/", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (RESERVED.has(u.username)) return c.json({ error: "This account cannot add a Mac" }, 400);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "Name the Mac" }, 400);
  const version = typeof b?.version === "string" ? b.version.slice(0, 40) : undefined;
  const { device, token, replaced } = pairDevice(u.username, name, version);
  // the same Mac paired again: its providers now run on the new record
  if (replaced.length) await moveProviders(u.username, replaced, device.id);
  return c.json({ device, token });
});

devicesApp.post("/code", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (RESERVED.has(u.username)) return c.json({ error: "This account cannot add a computer" }, 400);
  c.header("Cache-Control", "no-store");
  // url: where another computer reaches this server (null: it listens on this computer only, as for a phone)
  return c.json({ ...mintPairCode(u.username), url: await phoneOrigin(c) });
});

devicesApp.get("/", (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const admin = u.role === "admin";
  const list = listDevices((d) => d.owner === u.username || (admin && (d.owner === "workspace" || isAdminOwner(d.owner))));
  return c.json(list.map((d) => online(forViewer(u.username, d))));
});

/** The device an account may change: its own, or any for an admin. */
function manageable(u: AuthVars["user"], id: string): Device | null {
  const d = deviceOf(id);
  if (!d) return null;
  return d.owner === u.username || u.role === "admin" ? d : null;
}

devicesApp.patch("/:id", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const id = c.req.param("id");
  if (!manageable(u, id)) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "A computer needs a name" }, 400);
  const renamed = renameDevice(id, name);
  return renamed ? c.json(online(renamed)) : c.json({ error: "Not found" }, 404);
});

devicesApp.delete("/:id", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const id = c.req.param("id");
  if (!manageable(u, id)) return c.json({ error: "Not found" }, 404);
  await revokeDevice(id);
  return c.json({ ok: true });
});

/**
 * POST /api/devices/pair {code, name, version?} → {device, token}: a computer with no browser swaps its owner's one-time
 * code (lib/devices.ts mintPairCode) for its own `ctd_` token. Mounted before the account gate (boot.ts): the code is its
 * only credential, and a cookie sent with it changes nothing (the computer is always the code's account's). Five wrong
 * codes from one address are free, then each waits twice as long as the last (lib/sign-in-code.ts, as for passwords).
 */
export const devicePairApp = new Hono();
const PAIR_TRIES = "devices/pair"; // no account is named with a slash, so this lock is no account's
devicePairApp.post("/", async (c) => {
  c.header("Cache-Control", "no-store");
  const from = clientAddress(c);
  const wait = waitFor(PAIR_TRIES, from);
  if (wait) {
    c.header("Retry-After", String(Math.ceil(wait / 1000)));
    return c.json({ error: "Too many wrong codes. Try again later." }, 429);
  }
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (typeof b?.code !== "string" || !name) return c.json({ error: "code, name" }, 400);
  const paired = pairWithCode(b.code, name, typeof b.version === "string" ? b.version.slice(0, 40) : undefined);
  if (!paired) {
    wrongTry(PAIR_TRIES, from);
    return c.json({ error: "That code is used or expired. Create a new one in Settings → Computers." }, 400);
  }
  clearTries(PAIR_TRIES, from);
  if (paired.replaced.length) await moveProviders(paired.device.owner, paired.replaced, paired.device.id);
  return c.json({ device: paired.device, token: paired.token });
});
