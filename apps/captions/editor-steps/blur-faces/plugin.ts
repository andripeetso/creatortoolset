import { Hono } from "hono";
import { readFileSync } from "node:fs";
import { mkdir, open as openFile } from "node:fs/promises";
import path from "node:path";
import type { DeviceJob } from "../../contracts/devices";
import type { AuthVars } from "../../api/auth";
import { anyVisionConfigured, completeVisionWithFallback } from "../../api/ai-vision";
import { env } from "../../api/lib/env";
import { chosenIn, FACE_PICK_SYSTEM } from "../../api/lib/face-pick";
import { limitResetAt } from "../../contracts/plans";
import { isOnline, listDevices } from "../../api/lib/devices";
import { onEvent } from "../../api/lib/events";
import { wakeEditorPolls } from "../../api/lib/mac-claude";
import { definePlugin, requireGate } from "../../api/lib/plugin";
import { pluginOnIn } from "../../api/lib/plugin-workspaces";
import { projectOf } from "../../api/lib/project-of";
import { currentWorkspaceId } from "../../api/lib/workspace-scope";
import type { SessionUser } from "../../api/users";
import { blobs, libraryDb } from "../../api/library/db";
import { writeJsonAtomic } from "../../api/library/media/run";
import { saveToLibrary } from "../../api/library/routes";
import { mainSource } from "../../api/library/sources";
import { EXAMPLE_JPEG } from "./example";

/**
 * Face Blur: every face, or the ones the person names, covered in photos and videos on their own Mac or iPhone (the apps'
 * FaceBlur engine, Apple's face detector). The server keeps each account's settings and, in "Only some faces" mode, asks
 * the person's own AI which faces match their words (README.md has the whole contract).
 *   GET/PUT /api/x/blur-faces/settings   { mode, who, look, strength, softness, size, color, auto }; a PUT changes only
 *                                        the fields it sends
 *   GET     /api/x/blur-faces/example    { picture }: the example picture (base64 JPEG) the style is previewed on
 *   POST    /api/x/blur-faces/pick       { who, faces: [{ id, picture, note }] } → { blur: [ids] }; 409 + { error } when
 *                                        the AI can't answer (+ limit: { until } at its usage limit), and then the device
 *                                        writes nothing
 *   GET     /api/x/blur-faces/auto       { can, why?, failed: [{ versionId, title, error }] }: whether new Media Library
 *                                        files can be covered by themselves here, and the ones that could not
 *   POST    /api/x/blur-faces/auto/retry { versionId }   a failed one again
 * With `auto` on, each photo or video that comes into the account's built-in Media Library is covered by a Mac of its
 * own (the device job `faceblur`, deviceJobs below) and the covered copy is added beside it; the original stays.
 */

export type Look = "blur" | "mosaic" | "solid";
/**
 * The style is the engine's (FaceBlur/Cover.swift LookPreset): strength 0…1 (the blur, or the mosaic's squares), softness
 * 0…1 (how far the edge fades out), size 0.8…2 (the cover against the face), color (Solid's).
 */
export type Settings = { mode: "all" | "some"; who: string; look: Look; strength: number; softness: number; size: number; color: string; auto: boolean };
export const DEFAULTS: Omit<Settings, "softness"> = { mode: "all", who: "Every child's face", look: "blur", strength: 0.5, size: 1, color: "#343434", auto: false };
/** the edge a look has when the person never set one: Solid's is hard, as before there was a choice */
export const softnessOf = (look: Look) => (look === "solid" ? 0 : 0.45);
export const LIMITS = { who: 500, faces: 40, picture: 200_000, note: 300, size: [0.8, 2] as const };
const MODES: unknown[] = ["all", "some"];
const LOOKS: unknown[] = ["blur", "mosaic", "solid"];
const PER_CALL = 10; // faces (one picture each) per question to the AI
const ID = /^[A-Za-z0-9_-]{1,40}$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const fileOf = (user: string) => path.join(env.dataDir, "plugins", "blur-faces", `${user}.json`);
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
  const merged = { ...DEFAULTS, ...saved };
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
  if (s.auto !== undefined && typeof s.auto !== "boolean") return "auto is true or false.";
  const pick = <K extends keyof Settings>(k: K): Settings[K] => (s[k] ?? current[k]) as Settings[K];
  return {
    mode: pick("mode"), who: pick("who"), look: pick("look"), strength: pick("strength"), softness: pick("softness"),
    size: pick("size"), color: pick("color").toLowerCase(), auto: pick("auto"),
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
  if (!anyVisionConfigured(user)) return { error: `Face Blur needs your AI to choose the faces: connect one in Settings → Providers. ${NOTHING}` };
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
      if (limit) return { error: `Your AI is at its usage limit. ${NOTHING}`, limit: { until: limit.until ?? limitResetAt(msg) } };
      return { error: `Face Blur could not ask your AI which faces to blur (${msg}). ${NOTHING}` };
    }
    try {
      blur.push(...chosenIn(answer, ids));
    } catch (e) {
      return { error: `Face Blur could not read your AI's answer (${(e as Error).message}). ${NOTHING} Try again, or another AI in Settings → Providers.` };
    }
  }
  return { blur };
}

// ——— Covering what comes into the Media Library, on the person's Mac ———

export const AUTO_KIND = "faceblur";
/** How long a Mac may hold one file, and how many times a file goes back after its Mac went quiet before it fails. */
export const AUTO_LIMITS = { holdMs: 2 * 60 * 60_000, tries: 3 } as const;

export interface AutoJob {
  n: number;
  owner: string;
  libraryId: string;
  /** the library's workspace, whose settings cover it (none: nothing kept apart) */
  workspace?: string;
  versionId: string;
  title: string;
  kind: "video" | "image";
  state: "queued" | "running" | "failed" | "done";
  device?: string;
  since: number;
  tries: number;
  error?: string;
}
const autoFile = () => path.join(env.dataDir, "plugins", "blur-faces", "auto.json");
// ponytail: the whole list in one file, rewritten on each change; a table when accounts cover thousands of files
let auto: { next: number; jobs: AutoJob[] } | null = null;
const jobs = () => {
  if (!auto) {
    try {
      auto = JSON.parse(readFileSync(autoFile(), "utf8")) as { next: number; jobs: AutoJob[] };
    } catch {
      auto = { next: 1, jobs: [] };
    }
  }
  return auto;
};
let saving: Promise<void> = Promise.resolve();
const saveJobs = () => {
  const snapshot = JSON.parse(JSON.stringify(jobs())) as unknown;
  saving = saving.then(async () => {
    await mkdir(path.dirname(autoFile()), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(autoFile(), snapshot);
  }).catch((e: unknown) => console.warn(`[blur-faces] could not save its list: ${(e as Error).message}`));
};
/** Tests: forget the list kept in memory (and wait for the last save). */
export const resetAuto = async () => {
  await saving;
  auto = null;
};

/**
 * A file of `owner`'s came into a built-in Media Library: queued for their Mac when they asked for it in that library's
 * workspace, and Face Blur is on there. Never a copy this made, or a finished file made from a clip.
 */
export async function queueVersion(e: { libraryId: string; versionId: string; owner: string }): Promise<boolean> {
  if (mainSource()) return false;
  const workspace = await workspaceOfLibrary(e.owner, e.libraryId);
  if (!settingsOf(e.owner, workspace).auto || !(await pluginOnIn(faceBlur, e.owner, workspace))) return false;
  if (jobs().jobs.some((j) => j.versionId === e.versionId)) return false;
  const db = libraryDb();
  const a = db.prepare("SELECT a.kind, a.title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL").get(e.versionId) as
    | { kind: string; title: string }
    | undefined;
  if (!a || (a.kind !== "video" && a.kind !== "image")) return false;
  if (db.prepare("SELECT 1 FROM derived_from WHERE version_id = ?").get(e.versionId)) return false;
  const list = jobs();
  list.jobs.push({ n: list.next++, ...e, ...(workspace ? { workspace } : {}), title: a.title, kind: a.kind, state: "queued", since: Date.now(), tries: 0 });
  saveJobs();
  void wakeEditorPolls();
  return true;
}

/** A file whose Mac went quiet, or held it too long, goes back in the queue; after AUTO_LIMITS.tries it fails. */
function releaseStale(now = Date.now()): void {
  let changed = false;
  for (const j of jobs().jobs) {
    if (j.state !== "running" || (isOnline(j.device ?? "") && now - j.since < AUTO_LIMITS.holdMs)) continue;
    j.tries++;
    Object.assign(j, j.tries >= AUTO_LIMITS.tries ? { state: "failed", error: "Your Mac stopped before it finished this file, three times." } : { state: "queued", since: now });
    delete j.device;
    changed = true;
  }
  if (changed) saveJobs();
}

const held = (device: string, n: number) => jobs().jobs.find((j) => j.n === n && j.device === device && j.state === "running");
const end = (j: AutoJob, state: "done" | "failed", error?: string) => {
  j.state = state;
  delete j.device;
  if (error) j.error = error;
  else delete j.error;
  saveJobs();
};
const versionGone = (versionId: string) =>
  !libraryDb().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL").get(versionId);

/** Whether this account can have new Media Library files covered by itself here, and why not. */
export function autoCan(owner: string): { can: true } | { can: false; why: string } {
  if (mainSource()) return { can: false, why: "This server's Media Library comes from a plug-in, so Face Blur can't cover what comes into it by itself." };
  if (!listDevices((d) => d.owner === owner && !!d.kinds?.includes(AUTO_KIND)).length)
    return { can: false, why: "Covering new Media Library files needs the newest Creator Toolset Mac app, on a Mac connected to this account." };
  return { can: true };
}

export const autoJobs = {
  kind: AUTO_KIND,
  waits: (owner: string) => {
    releaseStale();
    return jobs().jobs.some((j) => j.owner === owner && j.state === "queued");
  },
  claim: (device: { id: string; owner: string }): DeviceJob | null => {
    releaseStale();
    for (const j of jobs().jobs) {
      if (j.owner !== device.owner || j.state !== "queued") continue;
      // a file deleted since it came in is not covered (and needs no word)
      if (versionGone(j.versionId)) {
        end(j, "done");
        continue;
      }
      Object.assign(j, { state: "running", device: device.id, since: Date.now() });
      saveJobs();
      const s = settingsOf(j.owner, j.workspace);
      const style = { look: s.look, strength: String(s.strength), softness: String(s.softness), size: String(s.size), color: s.color };
      return { id: j.n, kind: AUTO_KIND, editId: "", variant: "", options: { mode: s.mode, ...style, media: j.kind === "video" ? "video" : "photo" } };
    }
    return null;
  },
  input: async (device: string, n: number) => {
    const j = held(device, n);
    const v = j && (libraryDb().prepare("SELECT source_key, mime FROM asset_versions WHERE id = ?").get(j.versionId) as { source_key: string; mime: string | null } | undefined);
    return v ? { file: await blobs.localCopy(v.source_key), type: v.mime ?? "application/octet-stream" } : null;
  },
  /** { faces } → the ones the person's AI chose ({ blur }); { nothing } → done with no copy (no face found, none chosen). */
  answer: async (device: string, n: number, body: unknown) => {
    const j = held(device, n);
    if (!j) return { error: "Not found", status: 404 };
    const b = body as { faces?: unknown; nothing?: unknown } | null;
    if (typeof b?.nothing === "string") {
      end(j, "done");
      return { reply: { ok: true } };
    }
    const p = checkPick({ who: settingsOf(j.owner, j.workspace).who, faces: b?.faces });
    if (typeof p === "string") return { error: p, status: 400 };
    const r = await pickFaces(j.owner, p.who, p.faces);
    if ("error" in r) {
      end(j, "failed", r.error);
      return { error: r.error, status: 409 };
    }
    return { reply: r };
  },
  /** The covered copy: added to the original's own library (its workspace), beside it and linked to it. */
  file: async (device: string, n: number, file: string, _name: string) => {
    const j = held(device, n);
    if (!j) return { error: "Not found", status: 404 };
    const head = Buffer.alloc(12);
    const fh = await openFile(file, "r");
    await fh.read(head, 0, 12, 0).finally(() => fh.close());
    const right = j.kind === "video" ? head.toString("latin1", 4, 8) === "ftyp" : head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (!right) return { error: j.kind === "video" ? "Send the covered copy as an MP4." : "Send the covered copy as a JPEG.", status: 400 };
    const saved = await saveToLibrary(j.owner, file, `${j.title} blurred.${j.kind === "video" ? "mp4" : "jpg"}`, [j.versionId], j.libraryId, true);
    if (!saved) {
      end(j, "failed", "The covered copy could not be added: the Media Library is no longer yours to add to.");
      return { error: "Not yours", status: 403 };
    }
    if ("error" in saved) return { error: saved.error, status: 507 };
    end(j, "done");
    return { reply: { ok: true } };
  },
  fail: (device: string, n: number, why: string) => {
    const j = held(device, n);
    if (!j) return false;
    end(j, "failed", why);
    return true;
  },
};

routes.get("/auto", (c) => {
  const user = c.get("user").username;
  const failed = jobs().jobs.filter((j) => j.owner === user && j.state === "failed").map((j) => ({ versionId: j.versionId, title: j.title, error: j.error ?? "" }));
  return c.json({ ...autoCan(user), failed });
});

routes.post("/auto/retry", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as { versionId?: unknown } | null;
  const j = jobs().jobs.find((x) => x.owner === user && x.versionId === b?.versionId && x.state === "failed");
  if (!j) return c.json({ error: "Not found" }, 404);
  Object.assign(j, { state: "queued", since: Date.now(), tries: 0 });
  delete j.error;
  saveJobs();
  void wakeEditorPolls();
  return c.json({ ok: true });
});

// `kind` is read as text by Community's list of the team's plug-ins: a tool of its own, not a Home tool's, so it is listed under Other
const faceBlur = definePlugin({
  id: "blur-faces",
  name: "Face Blur",
  about: "Covers every face, or only the ones you name, in your photos and videos, on your Mac and iPhone",
  kind: "tool",
  gates: { ids: ["blur-faces"] },
  routes,
  deviceJobs: [autoJobs],
  start: () => void onEvent("library.version.probed", (e) => void queueVersion(e).catch((err: unknown) => console.warn(`[blur-faces] ${(err as Error).message}`))),
});
export default faceBlur;
