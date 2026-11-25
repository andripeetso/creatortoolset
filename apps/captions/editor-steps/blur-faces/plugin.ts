import { Hono } from "hono";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DeviceJob } from "../../contracts/devices";
import type { AuthVars } from "../../api/auth";
import { anyVisionConfigured, completeVisionWithFallback } from "../../api/ai-vision";
import { env } from "../../api/lib/env";
import { draining } from "../../api/server-update";
import { chosenIn, FACE_PICK_SYSTEM } from "../../api/lib/face-pick";
import { limitResetAt } from "../../contracts/plans";
import { isOnline, listDevices } from "../../api/lib/devices";
import { emitEvent, onEvent } from "../../api/lib/events";
import { wakeEditorPolls } from "../../api/lib/mac-claude";
import { definePlugin, requireGate } from "../../api/lib/plugin";
import { pluginOnIn } from "../../api/lib/plugin-workspaces";
import { projectOf } from "../../api/lib/project-of";
import { currentWorkspaceId } from "../../api/lib/workspace-scope";
import type { SessionUser } from "../../api/users";
import { BLUR_SQL, fileBlur, libraryDb } from "../../api/library/db";
import { importTarget } from "../../contracts/storage";
import { writeJsonAtomic } from "../../api/library/media/run";
import { libraryAccount } from "../../api/library/routes";
import { libraryChanged, mainSourceFor } from "../../api/library/access";
import { deleteVersions } from "../../api/library/trash";
import { EXAMPLE_JPEG } from "./example";
import { checkMade, HEX64, recordCopy } from "./copy";
import { reconnectRoutes } from "./reconnect";

/**
 * Face Blur: every face, or the ones the person names, covered in photos and videos on their own Mac or iPhone (the apps'
 * FaceBlur engine, Apple's face detector). The server keeps each account's settings and, in "Only some faces" mode, asks
 * the person's own AI which faces match their words (README.md has the whole contract).
 *   GET/PUT /api/x/blur-faces/settings   { mode, who, look, strength, softness, size, color }; a PUT changes only
 *                                        the fields it sends
 *   GET     /api/x/blur-faces/example    { picture }: the example picture (base64 JPEG) the style is previewed on
 *   POST    /api/x/blur-faces/pick       { who, faces: [{ id, picture, note }] } → { blur: [ids] }; 409 + { error } when
 *                                        the AI can't answer (+ limit: { until } at its usage limit), and then the device
 *                                        writes nothing
 *   GET     /api/x/blur-faces/auto       { can, why?, pausedUntil?, running: [versionId], failed: [{ versionId, title, error }] }
 *   POST    /api/x/blur-faces/auto/retry { versionId }   a failed one again
 * Each photo or video indexed on a Mac into the account's built-in Media Library marked Blur faces (contracts Blur "yes") is
 * covered on that Mac where the file is (the device job `faceblur-intake`, deviceJobs below), with the faces the person
 * described, and the copy becomes the clip's blurred version (docs/face-blur-intake-prd.md §3a); the original stays.
 */

export type Look = "blur" | "mosaic" | "solid";
/**
 * The style is the engine's (FaceBlur/Cover.swift LookPreset): strength 0…1 (the blur, or the mosaic's squares), softness
 * 0…1 (how far the edge fades out), size 0.8…2 (the cover against the face), color (Solid's).
 */
export type Settings = {
  mode: "all" | "some"; who: string; look: Look; strength: number; softness: number; size: number; color: string;
  /** the automatic blurred copies: long side ("original" keeps the file's), Mbps, and where on the Mac they are written */
  resolution: Resolution; bitrate: number; location: Location; folder: string;
};
export type Resolution = "1080" | "2160" | "original";
export type Location = "folder" | "beside" | "custom";
export const DEFAULTS: Omit<Settings, "softness"> = {
  mode: "all", who: "Every child's face", look: "blur", strength: 0.5, size: 1, color: "#343434",
  resolution: "1080", bitrate: 20, location: "folder", folder: "",
};
/** the edge a look has when the person never set one: Solid's is hard, as before there was a choice */
export const softnessOf = (look: Look) => (look === "solid" ? 0 : 0.45);
export const LIMITS = { who: 500, faces: 40, picture: 200_000, note: 300, size: [0.8, 2] as const, folder: 1000 };
export const RESOLUTIONS: readonly Resolution[] = ["1080", "2160", "original"];
export const BITRATES: readonly number[] = [10, 20, 40, 80];
export const LOCATIONS: readonly Location[] = ["folder", "beside", "custom"];
/** the long side the Mac writes for each resolution (0: the original's size) */
const LONG_SIDE: Record<Resolution, string> = { "1080": "1920", "2160": "3840", original: "0" };
const MODES: unknown[] = ["all", "some"];
const LOOKS: unknown[] = ["blur", "mosaic", "solid"];
const PER_CALL = 10; // faces (one picture each) per question to the AI
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const fileOf = (user: string) => path.join(env.dataDir, "plugins", "blur-faces", `${user}.json`);
/** Held (undo, until the owner resumes): files still queue, none is handed to a Mac. Kept on disk so a restart keeps it. */
const heldFile = (user: string) => path.join(env.dataDir, "plugins", "blur-faces", `${user}.held`);
const isHeld = (user: string) => existsSync(heldFile(user));
/** Hold or resume `user`'s automatic covers: Settings → Face Blur's switch, the library's Stop (off) and an undo (off). */
async function setHeld(user: string, held: boolean): Promise<void> {
  if (!held) {
    await rm(heldFile(user), { force: true });
    void wakeEditorPolls();
    return;
  }
  await mkdir(path.dirname(heldFile(user)), { recursive: true });
  await writeFile(heldFile(user), String(Date.now()));
}
/** The file: the account's settings from before they were per workspace (each workspace starts from them), and each workspace's own. */
type Saved = Partial<Settings> & { workspaces?: Record<string, Partial<Settings>> };
const readSaved = (user: string): Saved => {
  try {
    return JSON.parse(readFileSync(fileOf(user), "utf8")) as Saved;
  } catch {
    return {}; // none saved yet
  }
};

/** One workspace's settings (none: the account's own). Read whole each time (a few bytes): a device's claim reads it too, and that can't wait. */
export function settingsOf(user: string, workspace?: string): Settings {
  const { workspaces, ...base } = readSaved(user);
  const saved = { ...base, ...(workspace ? workspaces?.[workspace] : {}) };
  // `auto` (a switch before each file carried its blur answer) is read no more
  const { auto: _auto, ...merged } = { ...DEFAULTS, ...saved } as Settings & { auto?: unknown };
  return { ...merged, softness: saved.softness ?? softnessOf(merged.look) };
}

/** The workspace a Media Library is in (by its settings.projectId; one from before workspaces is the first brand's). */
async function workspaceOfLibrary(owner: string, libraryId: string): Promise<string | undefined> {
  const row = libraryDb().prepare("SELECT json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as { ws: string | null } | undefined;
  return (await projectOf({ username: owner } as SessionUser))?.(row?.ws ?? undefined);
}

const within = (v: unknown, lo: number, hi: number) => typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi;

/**
 * What a PUT sends on top of `current`, or what is wrong with it. A field left out keeps its value, so an app from before a
 * field existed never resets it.
 */
export function checkSettings(b: unknown, current: Settings = { ...DEFAULTS, softness: softnessOf(DEFAULTS.look) }): Settings | string {
  const s = b as Partial<Settings> | null;
  if (!s || typeof s !== "object" || Array.isArray(s)) return "Send the settings as an object.";
  if (s.mode !== undefined && !MODES.includes(s.mode)) return "mode is all or some.";
  if (s.look !== undefined && !LOOKS.includes(s.look)) return "look is blur, mosaic or solid.";
  if (s.who !== undefined && (typeof s.who !== "string" || s.who.length > LIMITS.who)) return `Which faces: a text of at most ${LIMITS.who} characters.`;
  if (s.strength !== undefined && !within(s.strength, 0, 1)) return "strength is between 0 and 1.";
  if (s.softness !== undefined && !within(s.softness, 0, 1)) return "softness is between 0 and 1.";
  if (s.size !== undefined && !within(s.size, ...LIMITS.size)) return `size is between ${LIMITS.size[0]} and ${LIMITS.size[1]}.`;
  if (s.color !== undefined && (typeof s.color !== "string" || !/^#[0-9a-f]{6}$/i.test(s.color))) return "color is #rrggbb.";
  if (s.resolution !== undefined && !RESOLUTIONS.includes(s.resolution)) return "resolution is 1080, 2160 or original.";
  if (s.bitrate !== undefined && !BITRATES.includes(s.bitrate)) return "bitrate is 10, 20, 40 or 80.";
  if (s.location !== undefined && !LOCATIONS.includes(s.location)) return "location is folder, beside or custom.";
  if (s.folder !== undefined && (typeof s.folder !== "string" || s.folder.length > LIMITS.folder || (s.folder !== "" && !s.folder.startsWith("/"))))
    return `folder is a full path starting with /, at most ${LIMITS.folder} characters.`;
  const pick = <K extends keyof Settings>(k: K): Settings[K] => (s[k] ?? current[k]) as Settings[K];
  return {
    mode: pick("mode"), who: pick("who"), look: pick("look"), strength: pick("strength"), softness: pick("softness"),
    size: pick("size"), color: pick("color").toLowerCase(),
    resolution: pick("resolution"), bitrate: pick("bitrate"), location: pick("location"), folder: pick("folder"),
  };
}

type Face = { id: string; picture: string; note: string };

/** The faces a pick sends, or what is wrong with them. */
export function checkPick(b: unknown): { who: string; faces: Face[] } | string {
  const p = b as { who?: unknown; faces?: unknown } | null;
  const who = typeof p?.who === "string" ? p.who.trim() : "";
  if (!who || who.length > LIMITS.who) return `Say which faces to blur, in at most ${LIMITS.who} characters.`;
  if (!Array.isArray(p!.faces)) return "Send the faces.";
  if (p!.faces.length > LIMITS.faces) return `At most ${LIMITS.faces} faces at a time.`;
  const seen = new Set<string>();
  for (const f of p!.faces as Partial<Face>[]) {
    if (typeof f?.id !== "string" || !ID.test(f.id) || seen.has(f.id)) return "Each face needs an id of its own.";
    seen.add(f.id);
    if (typeof f.picture !== "string" || !BASE64.test(f.picture)) return "Each face's picture is a JPEG as base64.";
    if (f.picture.length > Math.ceil(LIMITS.picture / 3) * 4) return `A face's picture is over ${LIMITS.picture / 1000} KB.`;
    if (typeof f.note !== "string" || f.note.length > LIMITS.note) return `A face's note is at most ${LIMITS.note} characters.`;
  }
  return { who, faces: p!.faces as Face[] };
}

const NOTHING = "Nothing was blurred.";

const routes = new Hono<{ Variables: AuthVars }>();
routes.use("*", requireGate("blur-faces"));

// each workspace has its own: the one this request works in
routes.get("/settings", async (c) => c.json(settingsOf(c.get("user").username, await currentWorkspaceId(c.get("user")))));

routes.get("/example", (c) => c.json({ picture: EXAMPLE_JPEG }));

routes.put("/settings", async (c) => {
  const user = c.get("user").username;
  const ws = await currentWorkspaceId(c.get("user"));
  const s = checkSettings(await c.req.json().catch(() => null), settingsOf(user, ws));
  if (typeof s === "string") return c.json({ error: s }, 400);
  const file = fileOf(user);
  const saved = readSaved(user);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(file, ws ? { ...saved, workspaces: { ...saved.workspaces, [ws]: s } } : { ...saved, ...s });
  return c.json(s);
});

routes.post("/pick", async (c) => {
  const p = checkPick(await c.req.json().catch(() => null));
  if (typeof p === "string") return c.json({ error: p }, 400);
  const r = await pickFaces(c.get("user").username, p.who, p.faces, c.req.raw.signal);
  return "error" in r ? c.json(r, 409) : c.json(r);
});

/** The ids of the faces that match `who`, by the person's own AI; an error sentence (ending "Nothing was blurred.") when it can't say. */
export async function pickFaces(user: string, who: string, faces: Face[], signal?: AbortSignal): Promise<{ blur: string[] } | { error: string; limit?: { until: number | null } }> {
  if (!faces.length) return { blur: [] };
  if (!anyVisionConfigured(user)) return { error: `Choosing faces needs an AI provider: add one in Settings → Providers. ${NOTHING}` };
  const blur: string[] = [];
  for (let i = 0; i < faces.length; i += PER_CALL) {
    const batch = faces.slice(i, i + PER_CALL);
    const ids = batch.map((f) => f.id);
    const ask = `The person's instruction: "${who}"\n\nThe faces, one picture each, in this order:\n${batch.map((f) => `${f.id}: ${f.note}`).join("\n")}\n\nWhich faces match the instruction?`;
    let answer: string;
    try {
      answer = (await completeVisionWithFallback(FACE_PICK_SYSTEM, ask, batch.map((f) => ({ jpegBase64: f.picture })), signal ?? new AbortController().signal, (t) => t, user, { label: "Face Blur" })).value;
    } catch (e) {
      const msg = (e as Error).message;
      // a usage limit says when it resets, as the chat's does (mac-claude.ts marks it; a gateway's 429 only says it in words)
      const limit = (e as { limited?: { until: number | null } }).limited ?? (/\b429\b|rate_limit_error/.test(msg) ? { until: limitResetAt(msg) } : undefined);
      if (limit) return { error: `The AI provider is at its usage limit. ${NOTHING}`, limit: { until: limit.until ?? limitResetAt(msg) } };
      return { error: `Face Blur could not ask the AI provider which faces to blur (${msg}). ${NOTHING}` };
    }
    try {
      blur.push(...chosenIn(answer, ids));
    } catch (e) {
      return { error: `Face Blur could not read the AI provider's answer (${(e as Error).message}). ${NOTHING}` };
    }
  }
  return { blur };
}

// ——— Covering what comes into the Media Library, on the Mac that has the file ———

/** The device job kind (docs/face-blur-intake-prd.md §3a). Mac apps from before list the old "faceblur" and never take it. */
export const AUTO_KIND = "faceblur-intake";
/** How long a Mac may hold one file, and how many times a file goes back after its Mac went quiet before it fails. */
export const AUTO_LIMITS = { holdMs: 2 * 60 * 60_000, tries: 3, awayMs: 10 * 60_000, pauseMs: 15 * 60_000 } as const;

export interface AutoJob {
  n: number;
  owner: string;
  libraryId: string;
  /** the library's workspace, whose settings cover it (none: nothing kept apart) */
  workspace?: string;
  versionId: string;
  title: string;
  kind: "video" | "image";
  state: "queued" | "running" | "failed";
  /** the Mac that has the file (the version's mac_device when it was queued), and the folder there the copy goes in */
  mac: string;
  out: string;
  device?: string;
  since: number;
  tries: number;
  error?: string;
  /** the original's full SHA-256, as its Mac read it (the key the copy links on) */
  sha256?: string;
  /** its Mac could not read it (disk not connected): not offered to that Mac again before this time */
  awayUntil?: number;
}
const autoFile = () => path.join(env.dataDir, "plugins", "blur-faces", "auto.json");
// shortcut: the whole list in one file, rewritten (coalesced) on each change; a table when accounts cover tens of thousands of files
type AutoList = { next: number; jobs: Record<string, AutoJob> };
let auto: AutoList | null = null;
const jobs = (): AutoList => {
  if (!auto) {
    try {
      const raw = JSON.parse(readFileSync(autoFile(), "utf8")) as { next: number; jobs: AutoJob[] | Record<string, AutoJob> };
      // a list from before (an array, the old kind's): its files are found again by the start-up sweep
      auto = Array.isArray(raw.jobs) ? { next: raw.next, jobs: {} } : (raw as AutoList);
    } catch {
      auto = { next: 1, jobs: {} };
    }
  }
  return auto;
};
const all = () => Object.values(jobs().jobs);
let saving: Promise<void> = Promise.resolve();
let dirty = false;
const saveJobs = () => {
  if (dirty) return; // one write already waits: it takes this change too
  dirty = true;
  saving = saving.then(async () => {
    dirty = false;
    const snapshot = structuredClone(jobs());
    await mkdir(path.dirname(autoFile()), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(autoFile(), snapshot);
  }).catch((e: unknown) => console.warn(`[blur-faces] could not save its list: ${(e as Error).message}`));
};
// shortcut: kept in memory, so a restart ends a pause early; stored when that wastes real usage
const paused = new Map<string, number>();
const pausedUntil = (owner: string, now = Date.now()) => ((paused.get(owner) ?? 0) > now ? paused.get(owner) : undefined);
/** Tests: forget the list and the pauses kept in memory (and wait for the last save). */
export const resetAuto = async () => {
  await saving;
  auto = null;
  paused.clear();
};

/** The folder on computer `device` a copy of `libraryId`'s file goes in: the library's Imports there (as saveOnComputer's). */
async function importsOn(owner: string, libraryId: string, device: string): Promise<string | null> {
  const { librariesOf, useOf } = await import("../../api/library/report");
  const { storageOf } = await import("../../api/devices-storage");
  for (const f of (await storageOf(owner)).folders) {
    if (useOf(f) !== "media" || f.origin.host !== device) continue;
    if ((await librariesOf(owner, f, false)).some((l) => l.id === libraryId)) return importTarget([f.origin.path], "Blurred");
  }
  return null;
}

/**
 * A file of `owner`'s came into a built-in Media Library, or was marked to blur later: queued for the Mac that has it when
 * the file is marked Blur faces and has no blurred render yet (api/library/db.ts fileBlur), and Face Blur is on in its
 * workspace. Never a copy this made, or a finished file made from a clip.
 */
export async function queueVersion(ev: { libraryId: string; versionId: string; owner: string }): Promise<boolean> {
  const f = fileBlur(ev.versionId);
  if (f?.blur !== "yes" || f.blurredVersionId) return false;
  if (jobs().jobs[ev.versionId]) return false;
  // the library's own account covers it, whoever added it: its Mac has the file, and its copy is trusted as the blurred render
  const e = { ...ev, owner: libraryAccount(ev.libraryId) ?? ev.owner };
  const workspace = await workspaceOfLibrary(e.owner, e.libraryId);
  if (await mainSourceFor(e.owner, workspace)) return false;
  if (!(await pluginOnIn(faceBlur, e.owner, workspace))) return false;
  const db = libraryDb();
  const a = db
    .prepare("SELECT a.kind, a.title, v.mac_path, v.mac_device FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL")
    .get(e.versionId) as { kind: string; title: string; mac_path: string | null; mac_device: string | null } | undefined;
  if (!a || (a.kind !== "video" && a.kind !== "image")) return false;
  // shortcut: only the computer that indexed the file (mac_device) covers it; read version_places when one file lives on several Macs
  if (!a.mac_path || !a.mac_device) return false;
  if (db.prepare("SELECT 1 FROM derived_from WHERE version_id = ?").get(e.versionId)) return false;
  const out = (await importsOn(e.owner, e.libraryId, a.mac_device)) ?? path.join(path.dirname(a.mac_path), "Blurred");
  if (jobs().jobs[e.versionId]) return false; // queued meanwhile, by the other event
  const list = jobs();
  list.jobs[e.versionId] = {
    n: list.next++, ...e, ...(workspace ? { workspace } : {}), title: a.title, kind: a.kind, state: "queued", mac: a.mac_device, out, since: Date.now(), tries: 0,
  };
  saveJobs();
  void wakeEditorPolls();
  return true;
}

/** Where the Mac writes a copy: the library's Blurred folder chosen when it was queued, the original's own folder, or the person's. */
export function outOf(s: Pick<Settings, "location" | "folder">, queued: string, macPath: string): string {
  if (s.location === "beside") return path.dirname(macPath);
  if (s.location === "custom" && s.folder) return s.folder;
  return queued;
}

/** A file whose Mac went quiet, or held it too long, goes back in the queue; after AUTO_LIMITS.tries it fails. */
function releaseStale(now = Date.now()): void {
  let changed = false;
  for (const j of all()) {
    if (j.state !== "running" || (isOnline(j.device ?? "") && now - j.since < AUTO_LIMITS.holdMs)) continue;
    j.tries++;
    Object.assign(j, j.tries >= AUTO_LIMITS.tries ? { state: "failed", error: "The computer stopped before it finished this file, three times." } : { state: "queued", since: now });
    delete j.device;
    changed = true;
  }
  if (changed) saveJobs();
}

const held = (device: string, n: number) => all().find((j) => j.n === n && j.device === device && j.state === "running");
/** Done: the copy is in, or the file is kept as filmed. Nothing is kept of it (queueVersion reads the library again). */
const done = (j: AutoJob) => {
  delete jobs().jobs[j.versionId];
  saveJobs();
};
const failed = (j: AutoJob, error: string) => {
  Object.assign(j, { state: "failed", error });
  delete j.device;
  saveJobs();
};
/** Back in the queue with no try counted. */
const back = (j: AutoJob, extra: Partial<AutoJob> = {}) => {
  Object.assign(j, { state: "queued", since: Date.now(), ...extra });
  delete j.device;
  saveJobs();
};
const versionGone = (versionId: string) =>
  !libraryDb().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL").get(versionId);
/** Ready to hand out to its Mac now: an AI provider to choose the faces, Which faces said, not paused. */
// draining: an update waits for running work (api/server-update.ts), so no new file goes to a Mac meanwhile
const ready = (owner: string) => !draining() && !pausedUntil(owner) && !isHeld(owner) && anyVisionConfigured(owner);
const offered = (j: AutoJob, device: string, now: number) => j.state === "queued" && j.mac === device && !(j.awayUntil && j.awayUntil > now);

/** No face to cover, or none the AI chose: the file is kept as filmed (its blur answer no), marked as gone over (blur_note none). */
function keepAsFilmed(versionId: string): void {
  libraryDb().prepare("UPDATE assets SET blur = 'no', blur_note = 'none' WHERE id = (SELECT asset_id FROM asset_versions WHERE id = ?)").run(versionId);
  emitEvent("library.changed", {});
}
/** The original's full SHA-256 its Mac read: kept on the job, and on the version when it has none (the copy links on it). */
function noteSha(j: AutoJob, sha: unknown): boolean {
  if (typeof sha !== "string" || !HEX64.test(sha)) return false;
  j.sha256 = sha;
  libraryDb().prepare("UPDATE asset_versions SET full_sha256 = ? WHERE id = ? AND full_sha256 IS NULL").run(sha, j.versionId);
  return true;
}

/** Whether this account can have new Media Library files covered by itself here, and why not. */
export async function autoCan(owner: string, workspace?: string): Promise<{ can: true } | { can: false; why: string }> {
  if (await mainSourceFor(owner, workspace)) return { can: false, why: "Not available while this workspace's Media Library comes from a plug-in." };
  if (!listDevices((d) => d.owner === owner && !!d.kinds?.includes(AUTO_KIND)).length) return { can: false, why: "Needs the Mac app" };
  if (!anyVisionConfigured(owner)) return { can: false, why: "Needs an AI provider" };
  if (!settingsOf(owner, workspace).who.trim()) return { can: false, why: "Needs Which faces" };
  return { can: true };
}

export const autoJobs = {
  kind: AUTO_KIND,
  waits: (owner: string, device: string) => {
    releaseStale();
    if (!ready(owner)) return false;
    const now = Date.now();
    return all().some((j) => j.owner === owner && offered(j, device, now));
  },
  // a file its Mac is blurring, or will take now: not one on a Mac that is offline, paused or without an AI provider
  // (a running job's Mac gone to sleep is not counted either: nothing releases it until a computer asks for work)
  preparing: (libraryId: string) => {
    const now = Date.now();
    const ok = new Map<string, boolean>(); // ready() reads files: once per owner, not once per file
    const isReady = (owner: string) => ok.get(owner) ?? ok.set(owner, ready(owner)).get(owner)!;
    const out: { versionId: string; running?: true; waiting?: true; failed?: true }[] = [];
    for (const j of all()) {
      if (j.libraryId !== libraryId) continue;
      if (j.state === "failed") out.push({ versionId: j.versionId, failed: true });
      else if (!(j.state === "running" ? isOnline(j.device ?? "") : offered(j, j.mac, now) && isOnline(j.mac)) || !isReady(j.owner)) out.push({ versionId: j.versionId, waiting: true });
      else out.push({ versionId: j.versionId, ...(j.state === "running" ? { running: true as const } : {}) });
    }
    return out;
  },
  claim: (device: { id: string; owner: string }): DeviceJob | null => {
    releaseStale();
    if (!ready(device.owner)) return null;
    const now = Date.now();
    for (const j of all()) {
      if (j.owner !== device.owner || !offered(j, device.id, now)) continue;
      // a file deleted since it came in, or kept as filmed since (its folder, its own answer), is not covered
      if (versionGone(j.versionId) || fileBlur(j.versionId)?.blur !== "yes") {
        done(j);
        continue;
      }
      const s = settingsOf(j.owner, j.workspace);
      if (!s.who.trim()) continue; // Which faces not said for its workspace: it waits (Settings says so)
      const v = libraryDb().prepare("SELECT mac_path FROM asset_versions WHERE id = ?").get(j.versionId) as { mac_path: string | null } | undefined;
      if (!v?.mac_path) continue;
      Object.assign(j, { state: "running", device: device.id, since: now });
      delete j.awayUntil;
      saveJobs();
      const style = { look: s.look, strength: String(s.strength), softness: String(s.softness), size: String(s.size), color: s.color };
      const output = { longSide: LONG_SIDE[s.resolution], bitrate: String(s.bitrate * 1_000_000) };
      return { id: j.n, kind: AUTO_KIND, editId: "", variant: "", options: { media: j.kind === "video" ? "video" : "photo", path: v.mac_path, out: outOf(s, j.out, v.mac_path), ...style, ...output } };
    }
    return null;
  },
  // the Mac reads the original where it is (§3a): nothing is ever sent to it
  input: async () => null,
  /** The Mac's steps (§3a): { back }, { nothing, sha256 }, { faces, sha256 } → { blur }, { made }. */
  answer: async (device: string, n: number, body: unknown): Promise<{ reply: unknown } | { error: string; status: number; back?: true }> => {
    const j = held(device, n);
    if (!j) return { error: "Not found", status: 404 };
    const b = (body ?? {}) as { back?: unknown; nothing?: unknown; faces?: unknown; sha256?: unknown; made?: unknown };
    if (typeof b.back === "string") {
      back(j, { awayUntil: Date.now() + AUTO_LIMITS.awayMs });
      return { reply: { ok: true } };
    }
    if (typeof b.nothing === "string") {
      noteSha(j, b.sha256);
      keepAsFilmed(j.versionId);
      done(j);
      return { reply: { ok: true } };
    }
    if (b.made !== undefined) {
      const m = checkMade(b.made);
      if (typeof m === "string") return { error: m, status: 400 };
      if (!j.sha256) return { error: "Send the original's sha256 with its faces first.", status: 400 };
      // linked as the blurred render only for the library's own account (its Mac, its trust); else a clip of its own
      const trusted = j.owner === libraryAccount(j.libraryId);
      const r = await recordCopy(j.libraryId, j.owner, device, m, trusted ? j.sha256 : undefined);
      // not this clip's blurred version (the copy was taken in as a clip of its own first): failed and kept, so the
      // start-up sweep never queues the original again and piles up copies
      if (!("versionId" in r) || (trusted && fileBlur(j.versionId)?.blurredVersionId !== r.versionId)) {
        const why = "The blurred copy was added to the Media Library as a clip of its own.";
        failed(j, why);
        return { error: why, status: 409 };
      }
      done(j);
      return { reply: { ok: true } };
    }
    if (!noteSha(j, b.sha256)) return { error: "Send the original's sha256 (64 hex characters).", status: 400 };
    const p = checkPick({ who: settingsOf(j.owner, j.workspace).who, faces: b.faces });
    if (typeof p === "string") return { error: p, status: 400 };
    const r = await pickFaces(j.owner, p.who, p.faces);
    if ("error" in r) {
      // at its usage limit: the file goes back with no try, and the account waits for the limit (or a while)
      if (r.limit) {
        back(j);
        paused.set(j.owner, r.limit.until ?? Date.now() + AUTO_LIMITS.pauseMs);
        return { error: r.error, status: 409, back: true };
      }
      // any other answer it can't give (a refusal, no list): a try for this file, so one file never stops the rest
      j.tries++;
      if (j.tries >= AUTO_LIMITS.tries) failed(j, r.error);
      else back(j);
      return { error: r.error, status: 409, back: true };
    }
    if (!r.blur.length) {
      keepAsFilmed(j.versionId);
      done(j);
    }
    return { reply: r };
  },
  file: async () => ({ error: "Send the copy's record ({ made }), not its bytes.", status: 400 }),
  fail: (device: string, n: number, why: string) => {
    const j = held(device, n);
    if (!j) return false;
    failed(j, why);
    return true;
  },
};

/** Every file waiting for its blur when the server starts (indexed before this, or queued while it was off), queued once. */
export async function sweep(): Promise<number> {
  const rows = libraryDb()
    .prepare(
      `SELECT v.id, a.library_id, a.created_by FROM assets a JOIN asset_versions v ON v.id = a.current_version_id
        WHERE a.trashed_at IS NULL AND a.kind IN ('video', 'image') AND v.blurred_of IS NULL AND v.mac_device IS NOT NULL AND ${BLUR_SQL} = 'yes'`,
    )
    .all() as { id: string; library_id: string; created_by: string }[];
  let queued = 0;
  for (const r of rows) if (await queueVersion({ libraryId: r.library_id, versionId: r.id, owner: r.created_by })) queued++;
  return queued;
}

routes.get("/auto", async (c) => {
  const user = c.get("user").username;
  const mine = all().filter((j) => j.owner === user);
  const until = pausedUntil(user);
  return c.json({
    ...(await autoCan(user, await currentWorkspaceId(c.get("user")))),
    ...(until ? { pausedUntil: until } : {}),
    held: isHeld(user),
    running: mine.filter((j) => j.state === "running").map((j) => j.versionId),
    failed: mine.filter((j) => j.state === "failed").map((j) => ({ versionId: j.versionId, title: j.title, error: j.error ?? "" })),
  });
});

routes.post("/auto/retry", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as { versionId?: unknown } | null;
  const j = typeof b?.versionId === "string" ? jobs().jobs[b.versionId] : undefined;
  if (!j || j.owner !== user || j.state !== "failed") return c.json({ error: "Not found" }, 404);
  back(j, { tries: 0 });
  delete j.error;
  void wakeEditorPolls();
  return c.json({ ok: true });
});

/**
 * Undo the automatic blur: every clip of the account's own libraries whose current version is a blurred copy made since
 * `since` (ms) goes back to its original, and the copy's version is deleted (the file on the Mac stays: the caller removes
 * it). The intake is held until it is turned on again (PUT /auto), so the originals are not blurred again meanwhile.
 */
export async function undoAuto(owner: string, since: number): Promise<{ versionId: string; macPath: string | null }[]> {
  await setHeld(owner, true);
  const d = libraryDb();
  const rows = (
    d
      .prepare(
        `SELECT a.id AS asset, a.library_id AS library, b.id AS blurred, b.mac_path AS macPath,
           (SELECT o.id FROM asset_versions o WHERE o.asset_id = a.id AND o.blurred_of IS NULL AND b.blurred_of IN (o.sha256, o.full_sha256)
             ORDER BY o.n DESC LIMIT 1) AS original
         FROM assets a JOIN asset_versions b ON b.id = a.current_version_id
         WHERE b.blurred_of IS NOT NULL AND b.created_at >= ?`,
      )
      .all(since) as { asset: string; library: string; blurred: string; macPath: string | null; original: string | null }[]
  ).filter((r) => r.original && libraryAccount(r.library) === owner);
  for (const r of rows) d.prepare("UPDATE assets SET current_version_id = ? WHERE id = ? AND current_version_id = ?").run(r.original, r.asset, r.blurred);
  await deleteVersions(rows.map((r) => r.blurred));
  for (const lib of new Set(rows.map((r) => r.library))) libraryChanged(lib);
  return rows.map((r) => ({ versionId: r.blurred, macPath: r.macPath }));
}

// POST /auto/undo { since } → { reverted: [{ versionId, macPath }] }; PUT /auto { on } → new files covered, or held
routes.post("/auto/undo", async (c) => {
  const since = ((await c.req.json().catch(() => null)) as { since?: unknown } | null)?.since;
  if (typeof since !== "number" || !Number.isFinite(since)) return c.json({ error: "since is a time in ms" }, 400);
  return c.json({ reverted: await undoAuto(c.get("user").username, since) });
});
routes.put("/auto", async (c) => {
  const on = ((await c.req.json().catch(() => null)) as { on?: unknown } | null)?.on;
  if (typeof on !== "boolean") return c.json({ error: "on is true or false" }, 400);
  await setHeld(c.get("user").username, !on);
  return c.json({ on });
});

// blurred copies made before this, added as their clips' blurred versions (reconnect.ts)
routes.route("/reconnect", reconnectRoutes);

// `kind` is read as text by Community's list of the team's plug-ins: a tool of its own, not a Home tool's, so it is listed under Other
const faceBlur = definePlugin({
  id: "blur-faces",
  name: "Face Blur",
  about: "Covers every face, or only the ones you name, in your photos and videos, on your Mac and iPhone",
  kind: "tool",
  gates: { ids: ["blur-faces"] },
  routes,
  deviceJobs: [autoJobs],
  start: () => {
    const queue = (e: { libraryId: string; versionId: string; owner: string }) => void queueVersion(e).catch((err: unknown) => console.warn(`[blur-faces] ${(err as Error).message}`));
    onEvent("library.version.probed", queue);
    onEvent("library.version.blur", queue);
    // the owner's Stop holds the automatic covers too, until the switch in Settings → Face Blur turns them on again; a
    // member's Stop leaves them: the hold is the owner's, for every library, and only the owner's switch lifts it
    onEvent("library.stopped", ({ libraryId, by }) => (by === (libraryAccount(libraryId) ?? by) ? setHeld(by, true) : undefined));
    // after start-up, so a long list never holds the server's first requests
    setTimeout(() => void sweep().catch((err: unknown) => console.warn(`[blur-faces] sweep: ${(err as Error).message}`)), 5_000).unref();
  },
});
export default faceBlur;
