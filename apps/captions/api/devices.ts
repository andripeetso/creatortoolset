import { Hono, type Context } from "hono";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { LOAD_PREFERENCES, type Device } from "../contracts/providers";
import { CUTOUT_KIND, parseKinds, parseModels, RESOLVE_KIND, TRANSCRIBE_KIND, type DeviceClaim } from "../contracts/devices";
import { clientAddress, phoneOrigin, type AuthVars } from "./auth";
import { claimableBy } from "./editor/engine";
import { cardsDraw, saveCard } from "./editor/cards/device";
import { beatForDevice, claimForDevice, doneForDevice, failForDevice, waitsForDevice } from "./editor/worker";
import { balanceFile, mayClaim, readBalance, type WorkerSeen } from "./lib/balance";
import { claimTranscript, declareModels, heldAudio, isComputerModel, modelsOutOfStep, transcriptFailed, transcriptSent, transcriptWaits } from "./lib/computer-transcribe";
import { claimCutout, cutoutFailed, cutoutSent, cutoutWaits, heldCutout } from "./lib/cutouts";
import { relayRoutes } from "./lib/mac-claude";
import { deviceOf, deviceForToken, forViewer, isOnline, listDevices, mintPairCode, moveProviders, pairDevice, pairWithCode, renameDevice, revokeDevice, setDeviceKinds, touchDevice } from "./lib/devices";
import { clearTries, waitFor, wrongTry } from "./lib/sign-in-code";
import { findUser } from "./users";
import { resolveGranted } from "./lib/packs";
import { storageApp } from "./devices-storage";

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
 *   GET /api/devices/relay/transcribe/:id, POST …/transcribe/:id | …/:id/fail   a transcript (lib/computer-transcribe.ts): the audio, the words or why not
 *   POST /api/devices/relay/wait | /report | /:id/text | /:id/step | /:id/done | /:id/fail
 *       (a /wait that lists `editor` kinds is answered { editor: true } when a step of one waits: contracts/devices.ts)
 *       the Mac app's side, Authorization: Bearer ctd_… (boot.ts checks it before the cookie gate); the same bodies
 *       as the relay routes in mac-claude.ts (relayRoutes)
 */

export const devicesApp = new Hono<{ Variables: AuthVars }>();

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
  if (!held || !getting || !asked) return c.json({ error: "models, getting, asked: lists of model ids" }, 400);
  const k = await declared(d, kinds);
  if (!k.includes(TRANSCRIBE_KIND)) return c.json({ job: claimCutout(d, k) ?? claimForDevice(d, k) } satisfies DeviceClaim);
  // a computer that runs speech models: what it has now, its transcript if one waits for it, and what its owner wants on it
  declareModels(d, held, getting, asked);
  const now = deviceOf(d.id)!;
  const job = claimCutout(now, k) ?? claimTranscript(now, await readBalance(d.owner)) ?? claimForDevice(now, k);
  return c.json({ job, models: deviceOf(d.id)!.stt!.want } satisfies DeviceClaim);
});
/** The kinds a device lists (its claim, or its long poll), kept as its own, and the ones of them it may take now. */
async function declared(d: Device, kinds: string[]): Promise<string[]> {
  // what the device runs is stored with it, so Settings → Devices can show it; a claim with none claims nothing
  // the Resolve bridge is switched on by a pack with Resolve items (the owner's Resolve plug-in or a downloaded one)
  const granted = kinds.includes(RESOLVE_KIND) && (await resolveGranted(d.owner));
  const claimable = [...claimableBy(kinds).filter((k) => k !== RESOLVE_KIND || granted), ...kinds.filter((k) => k === CUTOUT_KIND || k === TRANSCRIBE_KIND)];
  setDeviceKinds(d.id, claimable);
  return balancedKinds(d, claimable);
}
/**
 * The device's long poll lists the editor kinds it would claim right now (`editor`, contracts/devices.ts): they are kept
 * as the claim keeps them, and true says a claim made now would be handed a step, so the poll is answered with the hint.
 * A list that is no list of kinds is read as none sent.
 */
async function editorWaits(device: string, listed: unknown): Promise<boolean> {
  const d = deviceOf(device);
  const kinds = parseKinds(listed);
  return !!d && !!kinds && waits(d, await declared(d, kinds));
}
/**
 * Whether a step of one of these kinds waits for this device: an edit's (editor/worker.ts), a cut-out (lib/cutouts.ts),
 * or a transcript it would be handed (lib/computer-transcribe.ts); a computer whose wanted speech models changed is told too.
 */
const waits = async (d: Device, kinds: string[]) =>
  waitsForDevice(d.owner, kinds) || (kinds.includes(CUTOUT_KIND) && cutoutWaits(d.owner)) ||
  (kinds.includes(TRANSCRIBE_KIND) && (modelsOutOfStep(d) || transcriptWaits(d, await readBalance(d.owner))));
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

// a cut-out (contracts/devices.ts CUTOUT_KIND): the picture, and the PNG the Mac made of it or why it could not
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
  const wrong = cutoutSent(d.id, jobId(c), form.cutout instanceof File ? Buffer.from(await form.cutout.arrayBuffer()) : null);
  return wrong ? c.json({ error: wrong }, wrong === "Not found" ? 404 : 400) : c.json(await ended(d, true));
});
devicesApp.post("/relay/cutout/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  return c.json(await ended(d, cutoutFailed(d.id, jobId(c), typeof b?.error === "string" && b.error ? b.error : "Your Mac could not cut the picture out.")));
});

// a transcript (contracts/devices.ts TRANSCRIBE_KIND): the audio, and the words the computer heard or why it could not
devicesApp.get("/relay/transcribe/:id", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const file = heldAudio(d.id, jobId(c));
  return file ? new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { headers: { "content-type": "audio/wav" } }) : c.json({ error: "Not found" }, 404);
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

devicesApp.route("/relay", relayRoutes((c) => deviceForToken(c.req.header("authorization"))?.id ?? null, editorWaits));
devicesApp.route("/storage", storageApp);

/** Load balancing (Settings → Devices, lib/balance.ts readBalance). Admins only. */
const ALLOWED_WEIGHTS = new Set<number>(LOAD_PREFERENCES.map((x) => x.value));

devicesApp.get("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (u.role !== "admin") return c.json({ error: "Only an admin sees load balancing" }, 403);
  return c.json(await readBalance(u.username));
});

devicesApp.put("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (u.role !== "admin") return c.json({ error: "Only an admin changes load balancing" }, 403);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cur = await readBalance(u.username);
  if (typeof b?.on === "boolean") cur.on = b.on;
  if (b?.weights && typeof b.weights === "object") {
    for (const [id, v] of Object.entries(b.weights as Record<string, unknown>)) {
      if (deviceOf(id)?.owner !== u.username || typeof v !== "number" || !ALLOWED_WEIGHTS.has(v)) return c.json({ error: `Bad weight for ${id}` }, 400);
      cur.weights[id] = v;
    }
  }
  await mkdir(path.dirname(balanceFile(u.username)), { recursive: true });
  const tmp = `${balanceFile(u.username)}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cur, null, 2));
  await rename(tmp, balanceFile(u.username));
  return c.json(cur);
});

/** The same window as isOnline (lib/devices.ts): a computer that has not been heard from in 40 s is not a candidate. */
const ONLINE_MS = 40_000;
/**
 * The kinds `d` may take now under load balancing (lib/balance.ts): a kind goes to the best free computer among the
 * account's own. One computer (or balancing off) takes all of them.
 */
async function balancedKinds(d: Device, kinds: string[]): Promise<string[]> {
  const own = listDevices((x) => x.owner === d.owner);
  if (own.length < 2) return kinds;
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
  // a transcript picks its computer itself (lib/computer-transcribe.ts strongest: by the model it has and its graphics card)
  return kinds.filter((k) => k === TRANSCRIBE_KIND || mayClaim(k, d.id, workers, balance, now, ONLINE_MS));
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
  if (RESERVED.has(u.username)) return c.json({ error: "This account can't pair a Mac" }, 400);
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
  if (RESERVED.has(u.username)) return c.json({ error: "This account can't pair a computer" }, 400);
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
  if (!name) return c.json({ error: "Name the Mac" }, 400);
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
    return c.json({ error: "That code is used or expired. Get a new one in Settings → Devices." }, 400);
  }
  clearTries(PAIR_TRIES, from);
  if (paired.replaced.length) await moveProviders(paired.device.owner, paired.replaced, paired.device.id);
  return c.json({ device: paired.device, token: paired.token });
});
