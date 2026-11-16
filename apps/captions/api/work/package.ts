/** Item 4A: the package a computer gets for a step (design 2.2), and the edit-folder files it may fetch. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { WORK_V, type WorkFile, type WorkPackage, type WorkTable } from "../../contracts/work";
import { aiFor } from "../ai-complete";
import { isThisMachine } from "../lib/devices";
import { env } from "../lib/env";
import { sha256File } from "../lib/uploads";
import { libraryDb } from "../library/db";
import { whoFor } from "../library/describe";
import type { JobRow } from "../library/jobs";
import { writeJsonAtomic } from "../library/media/run";
import { fileFor, foldersOf } from "../editor/reach";
import { editDir, editRole, ownerOf, readDraft, readEdit, sourcesWorkspace, type EditMeta } from "../editor/store";

/** The server's copy of a package handed out: what the result is merged against. */
export const keptPath = (jobId: number) => path.join(env.dataDir, "work", `${jobId}.json`);

export function readKept(jobId: number): WorkPackage | null {
  try {
    return JSON.parse(readFileSync(keptPath(jobId), "utf8")) as WorkPackage;
  } catch {
    return null;
  }
}

/** "<editId>:<variant>" split: the variant is "" for a whole-edit step. */
export function splitJob(job: Pick<JobRow, "version_id">): { editId: string; variant: string } {
  const vid = job.version_id ?? "";
  const cut = vid.indexOf(":");
  return { editId: vid.slice(0, cut), variant: vid.slice(cut + 1) };
}

/** The editor caches kept per library version (analyze.ts, eyeline.ts, index.ts). */
export const CACHE_EXTS = ["energy.f32", "eyeline.json", "index.json"] as const;
const cacheDir = () => path.join(env.dataDir, "editor", "cache");

/** The library versions a step may read: the edit's sources and song, and for a version's step its draft's footage (B-roll). */
export function jobFiles(edit: EditMeta, variant: string): string[] {
  const draft = variant ? readDraft(edit.id, variant) : null;
  const fromDraft = Object.entries(draft?.timeline.sources ?? {}).filter(([, s]) => !s.file).map(([id]) => id);
  return [...new Set([...edit.sources, ...(typeof edit.song === "string" ? [edit.song] : []), ...fromDraft])];
}

/** The files of the job's library versions the step reads (design 2.1): an analyze reads only sources lacking a cache. */
function readsOf(kind: string, edit: EditMeta, variant: string, all: string[]): string[] {
  const has = (id: string, ext: string) => {
    try {
      return statSync(path.join(cacheDir(), `${id}.${ext}`)).isFile();
    } catch {
      return false;
    }
  };
  if (kind === "analyze") return edit.sources.filter((id) => !has(id, "energy.f32") || !has(id, "eyeline.json"));
  const draft = variant ? readDraft(edit.id, variant) : null;
  // a version's render, look and post read the draft's footage; before its draft, the edit's
  return draft ? Object.entries(draft.timeline.sources).filter(([, s]) => !s.file).map(([id]) => id) : all;
}

/** Every JSON file of the edit's folder, path relative to it → text (the folder's own dot folders left out). */
function editJson(dir: string, sub = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of readdirSync(path.join(dir, sub), { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const rel = sub ? `${sub}/${e.name}` : e.name;
    if (e.isDirectory()) Object.assign(out, editJson(dir, rel));
    else if (e.isFile() && e.name.endsWith(".json")) out[rel] = readFileSync(path.join(dir, rel), "utf8");
  }
  return out;
}

const rowsOf = (sql: string, ids: string[]) =>
  ids.length ? (libraryDb().prepare(sql.replace("?*", ids.map(() => "?").join(", "))).all(...ids) as Record<string, unknown>[]) : [];

/**
 * The package for `job`, claimed by `device`; keeps the server's copy at $DATA_DIR/work/<jobId>.json for the merge.
 * Throws when the step is not the device's own account's, or its files are not all readable in the edit's workspace.
 */
export async function buildPackage(job: JobRow, device: { id: string; owner: string }, gate?: unknown): Promise<WorkPackage> {
  const { editId, variant } = splitJob(job);
  const edit = readEdit(editId);
  if (!edit || edit.trashedAt) throw new Error("The edit is gone");
  // own account only: a computer never runs another person's step (design 4.3)
  if (!job.actor || job.actor !== device.owner) throw new Error("This step is not this computer's account's");
  const ids = jobFiles(edit, variant);
  // the access rule the worker checks at every step (worker.ts stillReadable), over every file the step may read
  if (sourcesWorkspace(ownerOf(edit), ids) !== edit.workspaceId || !(await editRole(job.actor, edit))) throw new Error("Some footage is gone or no longer yours to read");

  const db = libraryDb();
  const versions = rowsOf("SELECT * FROM asset_versions WHERE id IN (?*)", ids);
  const assetIds = [...new Set(versions.map((v) => String(v.asset_id)))];
  const assets = rowsOf("SELECT * FROM assets WHERE id IN (?*)", assetIds);
  const libIds = [...new Set(assets.map((a) => String(a.library_id)))];
  const rows: WorkPackage["rows"] = {
    // bucket settings never leave the server: the computer reads files through the package's file list, never a bucket
    libraries: rowsOf("SELECT * FROM libraries WHERE id IN (?*)", libIds).map((l) => ({ ...l, storage_kind: "local", storage_config: null })),
    assets,
    asset_versions: versions,
    ...Object.fromEntries(
      (
        [
          ["asset_tags", "asset_id", assetIds],
          ["descriptions", "version_id", ids],
          ["transcripts", "version_id", ids],
          ["stretches", "version_id", ids],
          ["derivatives", "version_id", ids],
        ] as [WorkTable, string, string[]][]
      ).map(([t, col, list]) => [t, rowsOf(`SELECT * FROM ${t} WHERE ${col} IN (?*)`, list)]),
    ),
    edit_jobs: db.prepare("SELECT * FROM edit_jobs WHERE edit_id = ?").all(editId) as Record<string, unknown>[],
  };

  // the files the step reads, each with this computer's own path to it when it has one (reach.ts fileFor)
  const folders = foldersOf(device.owner);
  const post = job.kind === "post" && !!edit.steps?.length;
  const q = db.prepare(
    `SELECT v.id, v.source_key, v.source_path, v.mac_path, v.mac_device, v.bytes, v.sha256, a.title,
       d.storage_key AS proxy, d.bytes AS proxy_bytes
     FROM asset_versions v JOIN assets a ON a.id = v.asset_id
     LEFT JOIN derivatives d ON d.version_id = v.id AND d.kind = 'proxy' WHERE v.id = ?`,
  );
  const files: WorkFile[] = readsOf(job.kind, edit, variant, ids).flatMap((id) => {
    const r = q.get(id) as
      | { id: string; source_key: string; source_path: string | null; mac_path: string | null; mac_device: string | null; bytes: number; sha256: string; title: string; proxy: string | null; proxy_bytes: number | null }
      | undefined;
    if (!r) return [];
    const at = fileFor(r, device.id, folders, isThisMachine);
    // a proxies-only library's source is its proxy (library/worker.ts dropOriginal): that is the proxy, not an original
    const proxy = r.proxy ? { bytes: r.proxy_bytes ?? 0 } : undefined;
    return [
      {
        id: r.id,
        title: r.title,
        bytes: r.bytes,
        ...(r.sha256.startsWith("mac:") ? { quick: r.sha256.slice(4) } : {}),
        ...(at && "path" in at ? { path: at.path } : {}),
        ...(proxy ? { proxy } : {}),
        ...(post ? { original: true as const } : {}),
      },
    ];
  });

  const caches: Record<string, string> = {};
  for (const id of ids)
    for (const ext of CACHE_EXTS) {
      try {
        caches[`${id}.${ext}`] = readFileSync(path.join(cacheDir(), `${id}.${ext}`)).toString("base64");
      } catch {
        // not made yet
      }
    }

  const dir = editDir(editId);
  const own: WorkPackage["own"] = [];
  for (const rel of ownOf(job.kind, edit, variant)) {
    const abs = path.join(dir, rel);
    try {
      own.push({ path: rel, bytes: statSync(abs).size, sha256: await sha256File(abs) });
    } catch {
      // not there: the step says what it misses, as on the server
    }
  }

  const who = whoFor(job.actor);
  const pkg: WorkPackage = {
    v: WORK_V,
    job: { id: job.id, kind: job.kind, editId, variant, actor: job.actor, workspaceId: edit.workspaceId },
    edit: editJson(dir),
    own,
    rows,
    files,
    caches,
    ...(gate === undefined ? {} : { gate }),
    ai: { editor: aiFor(who, "editor", "AI Editor").off ?? null, analyzer: aiFor(who, "analyzer", "AI Editor").off ?? null },
    ...(job.kind === "post" ? { steps: (edit.steps ?? []).map((s) => s.id) } : {}),
  };
  await mkdir(path.dirname(keptPath(job.id)), { recursive: true });
  await writeJsonAtomic(keptPath(job.id), pkg);
  return pkg;
}

/** The edit-folder media a step reads: the draft's own clips (cards, generated shots), and for critique the rendered preview. */
function ownOf(kind: string, edit: EditMeta, variant: string): string[] {
  const draft = variant ? readDraft(edit.id, variant) : null;
  const clips = Object.values(draft?.timeline.sources ?? {}).flatMap((s) => (s.file ? [s.file] : []));
  return [...new Set([...clips, ...(kind === "critique" && variant ? [`previews/${variant}.mp4`] : [])])];
}

/** The absolute path of an edit-folder file the package names, else null. */
export function ownFile(jobId: number, rel: string): string | null {
  const pkg = readKept(jobId);
  if (!pkg || !pkg.own.some((o) => o.path === rel)) return null;
  const dir = editDir(pkg.job.editId);
  const abs = path.resolve(dir, rel);
  return abs.startsWith(dir + path.sep) ? abs : null;
}
