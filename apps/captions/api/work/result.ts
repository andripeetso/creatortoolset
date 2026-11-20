/** Item 4A: taking a computer's result back (design 2.3). */
import { createWriteStream, readFileSync } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import type { Critique } from "../../contracts/edit-plan";
import type { WorkResult } from "../../contracts/work";
import { env } from "../lib/env";
import { announce } from "../lib/sync";
import { libraryDb } from "../library/db";
import { defer, enqueueJob, type JobRow, parkJob } from "../library/jobs";
import { writeJsonAtomic } from "../library/media/run";
import { runEnded } from "../editor/ended";
import { coreSteps } from "../editor/engine";
import { editLeaves, fileInReview } from "../editor/preview";
import { editDir, readDraft, readEdit, readStep, saveDraft, saveStep, type DraftFile } from "../editor/store";
import { doneForDevice, failForDevice } from "../editor/worker";
import { CACHE_EXTS, keptPath, readKept, splitJob } from "./package";

/** Size caps per upload: a rendered preview or generated clip, and an editor cache file. */
export const MAX_MEDIA = 4 * 1024 ** 3;
export const MAX_CACHE = 256 * 1024 ** 2;

const heldBy = (jobId: number, deviceId: string) =>
  libraryDb().prepare("SELECT * FROM edit_jobs WHERE id = ? AND device = ? AND state = 'running'").get(jobId, deviceId) as JobRow | undefined;

/** A path relative to a folder: no absolute path, no `..`, no backslash, no empty or dot segment. */
const plain = (rel: string) => !!rel && !rel.startsWith("/") && !rel.includes("\\") && !rel.includes("\0") && rel.split("/").every((s) => s && s !== "." && s !== ".." && !s.startsWith("."));

const DRAFT = /^drafts\/(v[1-9]|m[1-9]\d?)\.json$/;

/**
 * Where an uploaded result file goes, relative to $DATA_DIR, with its size cap; null when it is not allowed. `rel` is
 * relative to $DATA_DIR: `editor/<editId>/<media>` (never a JSON file: those come in the result and are merged), or
 * `editor/cache/<version>.<energy.f32|eyeline.json|index.json>` for one of the job's files.
 */
function allowed(jobId: number, rel: string): { editId: string; cap: number } | null {
  const pkg = readKept(jobId);
  if (!pkg || !plain(rel)) return null;
  const { editId } = pkg.job;
  const parts = rel.split("/");
  if (parts[0] !== "editor") return null;
  // media only: JSON comes back in result.edit, merged per key; the preview's waveform (previews/<v>.wave.json) is media
  if (parts[1] === editId && parts.length > 2 && (!rel.endsWith(".json") || /^previews\/[^/]+\.wave\.json$/.test(parts.slice(2).join("/"))))
    return { editId, cap: MAX_MEDIA };
  if (parts[1] === "cache" && parts.length === 3) {
    const ids = new Set((pkg.rows.asset_versions ?? []).map((v) => String(v.id)));
    const ok = CACHE_EXTS.some((ext) => parts[2]!.endsWith(`.${ext}`) && ids.has(parts[2]!.slice(0, -ext.length - 1)));
    return ok ? { editId, cap: MAX_CACHE } : null;
  }
  return null;
}

const incoming = (editId: string, jobId: number) => path.join(editDir(editId), ".incoming", String(jobId));

/** Streams one result file into editor/<editId>/.incoming/<jobId>/ when `rel` is allowed; false when it is not. */
export async function acceptUpload(jobId: number, deviceId: string, rel: string, body: Readable): Promise<boolean> {
  const job = heldBy(jobId, deviceId);
  if (!job) return false;
  const ok = allowed(jobId, rel);
  if (!ok) return false;
  // no media of a step whose sources include a file marked Blur faces with no blurred render yet (editor/preview.ts
  // editLeaves), read by the job's own version, never by the file's name (a preview's sheets are previews/<v>.sheets/<n>.jpg)
  if (rel.startsWith(`editor/${ok.editId}/`) && !editLeaves(ok.editId, splitJob(job).variant).ok) return false;
  const out = path.join(incoming(ok.editId, jobId), rel);
  await mkdir(path.dirname(out), { recursive: true });
  let n = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      n += chunk.length;
      done(n > ok.cap ? new Error("The file is larger than allowed") : null, chunk);
    },
  });
  try {
    await pipeline(body, cap, createWriteStream(out));
  } catch {
    await rm(out, { force: true });
    return false;
  }
  return true;
}

const parse = (text: string | undefined): unknown => {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const isMap = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const readText = (abs: string) => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return undefined;
  }
};

/**
 * One JSON file merged per top-level key: the keys the step changed or removed (against the package's copy) are set on
 * the server's current file; the keys it did not touch keep the server's value. A file that is no map is replaced.
 */
export function mergeKeys(base: unknown, mine: unknown, cur: unknown): unknown {
  if (!isMap(mine) || !isMap(cur)) return mine;
  const was = isMap(base) ? base : {};
  const out = { ...cur };
  for (const k of new Set([...Object.keys(was), ...Object.keys(mine)])) {
    if (isDeepStrictEqual(was[k], mine[k])) continue;
    if (k in mine) out[k] = mine[k];
    else delete out[k];
  }
  return out;
}

/** The result being applied per edit: two computers' results for one edit apply one after the other, so each merge reads
 *  the file the other wrote (a merge reads, then writes after an await). */
const applying = new Map<string, Promise<unknown>>();

/** Applies a result while `deviceId` still holds the step; false (nothing applied) when it does not. */
export function applyResult(jobId: number, deviceId: string, r: WorkResult): Promise<boolean> {
  const { editId } = splitJob(heldBy(jobId, deviceId) ?? { version_id: "" });
  const next = (applying.get(editId) ?? Promise.resolve()).catch(() => {}).then(() => applyNow(jobId, deviceId, r));
  applying.set(editId, next);
  void next.catch(() => {}).finally(() => applying.get(editId) === next && applying.delete(editId));
  return next;
}

async function applyNow(jobId: number, deviceId: string, r: WorkResult): Promise<boolean> {
  const job = heldBy(jobId, deviceId);
  const pkg = job && readKept(jobId);
  if (!job || !pkg) return false;
  const { editId, variant } = splitJob(job);
  const dir = editDir(editId);
  const inc = incoming(editId, jobId);

  // 1. uploads into place
  for (const rel of r.uploads) {
    if (!allowed(jobId, rel)) continue;
    const from = path.join(inc, rel);
    const to = path.join(env.dataDir, rel);
    if (!(await stat(from).catch(() => null))) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await rename(from, to);
  }

  // 2. JSON files, per top-level key; a draft saved as a new revision through saveDraft, so the server's revisions rotate
  const put = Object.entries(r.edit.put).filter(([p]) => plain(p) && p.endsWith(".json") && pkg.edit[p] !== r.edit.put[p]);
  const newRevision = (name: string) => put.some(([p]) => new RegExp(`^drafts/${name}\\.r\\d+\\.json$`).test(p) && !(p in pkg.edit));
  for (const [p, text] of put) {
    if (/^drafts\/[^/]+\.r\d+\.json$/.test(p)) continue; // the computer's own rotation: the server makes its own
    const mine = parse(text);
    if (mine === undefined) continue;
    const draft = DRAFT.exec(p)?.[1];
    if (draft && newRevision(draft)) {
      await saveDraft(editId, draft, mine as DraftFile);
      continue;
    }
    const abs = path.join(dir, p);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeJsonAtomic(abs, mergeKeys(parse(pkg.edit[p]), mine, parse(readText(abs))));
  }
  // removed: only files the server has not changed since the package
  for (const p of r.edit.gone) {
    if (!plain(p) || !p.endsWith(".json") || pkg.edit[p] === undefined) continue;
    const abs = path.join(dir, p);
    if (readText(abs) === pkg.edit[p]) await rm(abs, { force: true });
  }

  // 3. post: the copies stay on that computer
  if (r.kept && job.kind === "post") {
    const post = readStep(editId, "post") ?? {};
    await saveStep(editId, "post", { ...post, [variant]: { files: r.kept, notes: post[variant]?.notes ?? [], on: deviceId } as (typeof post)[string] });
  }

  // 4. the preview into Review, with the thumbnail and waveform made on the computer; before what the step queued, as
  // the step itself files it first (critique.ts): a file step queued sooner would find no preview in Review yet
  const edit = readEdit(editId);
  const rv = r.effects.review;
  // only this step's own version
  const d = rv && edit && rv.variant === variant && readDraft(editId, rv.variant);
  if (rv && d && edit) {
    const given = (rel: string) => (rel && allowed(jobId, rel) ? path.join(env.dataDir, rel) : undefined);
    await fileInReview(edit, rv.variant, d.timeline, rv.fails as Critique["fails"], job.actor, { thumb: given(rv.thumb), wave: given(rv.wave) });
  }

  // 5. what the step queued: this edit's versions and core kinds only
  const db = libraryDb();
  const kinds = new Set(Object.keys(coreSteps()));
  for (const q of r.effects.queue ?? []) {
    const [e, v = ""] = q.version.split(/:(.*)/s);
    if (edit && e === editId && (!v || /^(v[1-9]|m[1-9]\d?)$/.test(v)) && kinds.has(q.kind)) enqueueJob(db, edit.workspaceId, `${editId}:${v}`, q.kind, job.actor, true, "edit_jobs");
  }

  // 6. the outcome, as runStep classifies a throw (editor/worker.ts)
  const o = r.outcome;
  const moved = () => (announce(job.actor ?? "", "editor"), runEnded(job));
  if ("done" in o) doneForDevice(deviceId, jobId);
  else if ("error" in o) failForDevice(deviceId, jobId, o.error);
  else {
    db.prepare("UPDATE edit_jobs SET device = NULL WHERE id = ?").run(jobId);
    if ("needsKey" in o) parkJob(db, jobId, o.needsKey, "edit_jobs");
    else {
      const w = "wait" in o ? o.wait : o.limit;
      if (w.line) db.prepare("UPDATE edit_jobs SET error = ? WHERE id = ?").run(w.line, jobId);
      defer(db, jobId, w.seconds, Date.now(), "edit_jobs");
    }
    moved();
  }
  await rm(inc, { recursive: true, force: true });
  await rm(keptPath(jobId), { force: true });
  return true;
}
