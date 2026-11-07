import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { MAX_VERSIONS, type Edit, type Timeline, type EditBrief, type EditJob, type EditSummary, type Line, type ReviewPreview, type Sentence, type VersionPlan } from "../../contracts/editor";
import { env } from "../lib/env";
import { libraryRole } from "../library/access";
import { libraryDb } from "../library/db";
import { writeJsonAtomic } from "../library/media/run";

/**
 * The AI Editor's edits: $DATA_DIR/editor/<id>/edit.json (what the user asked for), and its steps in the library
 * database's `edit_jobs` (version_id "<id>:<variant>"). An edit belongs to its creator, in the workspace of the
 * library its footage is in; the workspace's owner sees it too.
 */

export interface EditMeta extends EditBrief {
  id: string;
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  sources: string[];
  /** per source version, set on the edit page (PUT eyeline) */
  eyeline?: Record<string, number>;
  trashedAt?: number;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const root = () => path.join(env.dataDir, "editor");
export const editDir = (id: string) => path.join(root(), id);
const fileOf = (id: string) => path.join(editDir(id), "edit.json");
const MAX_SOURCES = 50;

/** The edit, trashed or not; null for an id that is no edit. */
export function readEdit(id: string): EditMeta | null {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(readFileSync(fileOf(id), "utf8")) as EditMeta;
  } catch {
    return null;
  }
}

export const saveEdit = (e: EditMeta) => writeJsonAtomic(fileOf(e.id), { ...e, updatedAt: Date.now() });

/** What the steps found, each in its own file beside edit.json, so a step never overwrites a change the user made meanwhile. */
export interface StepFiles {
  analysis: { sentences: Sentence[]; notes: string[] };
  plan: { lines: Line[]; plans: VersionPlan[]; notes: string[] };
  /** each version's preview in Review (preview.ts) */
  review: Record<string, ReviewPreview>;
}

export function readStep<K extends keyof StepFiles>(id: string, name: K): StepFiles[K] | null {
  try {
    return JSON.parse(readFileSync(path.join(root(), id, `${name}.json`), "utf8")) as StepFiles[K];
  } catch {
    return null;
  }
}

export const saveStep = <K extends keyof StepFiles>(id: string, name: K, value: StepFiles[K]) => writeJsonAtomic(path.join(root(), id, `${name}.json`), value);

/** A version's draft as the draft step saved it: drafts/<name>.json. */
export interface DraftFile {
  timeline: Timeline;
  notes: string[];
}

const DRAFT = /^v[1-9]$/;

export function readDraft(id: string, name: string): DraftFile | null {
  if (!DRAFT.test(name)) return null;
  try {
    return JSON.parse(readFileSync(path.join(editDir(id), "drafts", `${name}.json`), "utf8")) as DraftFile;
  } catch {
    return null;
  }
}

export async function saveDraft(id: string, name: string, d: DraftFile): Promise<void> {
  await mkdir(path.join(editDir(id), "drafts"), { recursive: true });
  await writeJsonAtomic(path.join(editDir(id), "drafts", `${name}.json`), d);
}

/** The names of the edit's drafts, in order. */
export function draftNames(id: string): string[] {
  try {
    return readdirSync(path.join(editDir(id), "drafts"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((n) => DRAFT.test(n))
      .sort();
  } catch {
    return [];
  }
}

/** Every edit on the server, trashed ones too. */
export function allEdits(): EditMeta[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(root());
  } catch {
    /* no edit yet */
  }
  return ids.map(readEdit).filter((e): e is EditMeta => !!e);
}

/** Whether the edit is `username`'s own (out of the trash): nobody else sees or changes it. */
export const editRole = (username: string, e: EditMeta | null): boolean => !!e && !e.trashedAt && e.createdBy === username;

/**
 * The workspace the versions' libraries are in, when `username` may read every one of them (out of the trash, in one
 * workspace). Null otherwise: the caller answers 404, as for a version that does not exist.
 */
export function sourcesWorkspace(username: string, versionIds: string[]): string | null {
  const db = libraryDb();
  let ws: string | null = null;
  for (const id of versionIds) {
    const row = db
      .prepare(
        `SELECT l.id AS library_id, l.workspace_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
         JOIN libraries l ON l.id = a.library_id WHERE v.id = ? AND a.trashed_at IS NULL`,
      )
      .get(id) as { library_id: string; workspace_id: string } | undefined;
    if (!row || !libraryRole(username, row.library_id) || (ws && ws !== row.workspace_id)) return null;
    ws = row.workspace_id;
  }
  return ws;
}

/** A B-roll collection that is not the user's to read: the routes answer 404. */
export class NoCollection extends Error {}

/** A collection `username` may read in workspace `ws`, for B-roll. */
function collectionOk(username: string, ws: string, id: string): boolean {
  const row = libraryDb().prepare("SELECT l.id, l.workspace_id FROM collections c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?").get(id) as
    | { id: string; workspace_id: string }
    | undefined;
  return !!row && row.workspace_id === ws && !!libraryRole(username, row.id);
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** The brief fields of a body, cleaned; a field that is absent or of the wrong type is left out. Throws on a B-roll collection the user can't read. */
export function cleanBrief(body: Record<string, unknown>, username: string, ws: string): Partial<EditBrief> {
  const out: Partial<EditBrief> = {};
  const name = text(body.name, 120);
  if (name) out.name = name;
  const brief = text(body.brief, 20_000);
  if (brief !== undefined) out.brief = brief;
  const script = text(body.script, 100_000);
  if (script !== undefined) out.script = script;
  const versions = num(body.versions, 1, MAX_VERSIONS);
  if (versions !== undefined) out.versions = Math.round(versions);
  const targetS = num(body.targetS, 0, 3600);
  if (targetS !== undefined) out.targetS = Math.round(targetS);
  if (body.brollCollectionId === null) out.brollCollectionId = null;
  else if (typeof body.brollCollectionId === "string") {
    if (!collectionOk(username, ws, body.brollCollectionId)) throw new NoCollection("No such collection");
    out.brollCollectionId = body.brollCollectionId;
  }
  const punch = num((body.framing as { punch?: unknown } | undefined)?.punch, 1, 2);
  if (punch !== undefined) out.framing = { punch };
  return out;
}

/** A new edit of `sources` for `username`, or null when a source is not theirs to read. */
export async function createEdit(username: string, body: Record<string, unknown>): Promise<EditMeta | null> {
  const sources = Array.isArray(body.sources) ? [...new Set(body.sources.filter((s): s is string => typeof s === "string"))] : [];
  if (!sources.length || sources.length > MAX_SOURCES) return null;
  const ws = sourcesWorkspace(username, sources);
  if (!ws) return null;
  const now = Date.now();
  const e: EditMeta = {
    id: randomUUID(),
    workspaceId: ws,
    createdBy: username,
    createdAt: now,
    updatedAt: now,
    sources,
    name: "Untitled edit",
    brief: "",
    script: "",
    versions: 1,
    targetS: 0,
    brollCollectionId: null,
    framing: { punch: 1.15 },
    ...cleanBrief(body, username, ws),
  };
  mkdirSync(path.dirname(fileOf(e.id)), { recursive: true });
  await saveEdit(e);
  return e;
}

interface JobDbRow {
  id: number;
  version_id: string;
  kind: string;
  state: EditJob["state"];
  attempts: number;
  error: string | null;
}

export function jobsOf(id: string): EditJob[] {
  const rows = libraryDb().prepare("SELECT id, version_id, kind, state, attempts, error FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id) as unknown as JobDbRow[];
  return rows.map((r) => ({ id: r.id, kind: r.kind, variant: r.version_id.slice(id.length + 1), state: r.state, attempts: r.attempts, error: r.error }));
}

export function summaryOf(e: EditMeta): EditSummary {
  const last = libraryDb().prepare("SELECT kind, state FROM edit_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1").get(e.id) as EditSummary["last"] | undefined;
  return { id: e.id, name: e.name, createdBy: e.createdBy, createdAt: e.createdAt, updatedAt: e.updatedAt, sources: e.sources, last: last ? { ...last } : null };
}

export function viewOf(e: EditMeta): Edit {
  const { trashedAt: _, ...meta } = e;
  const a = readStep(e.id, "analysis");
  const p = readStep(e.id, "plan");
  return {
    ...meta,
    ...summaryOf(e),
    jobs: jobsOf(e.id),
    eyeline: e.eyeline ?? {},
    drafts: draftNames(e.id),
    sentences: a?.sentences.length ?? 0,
    lines: p?.lines ?? [],
    plans: p?.plans ?? [],
    notes: [...(a?.notes ?? []), ...(p?.notes ?? [])],
    previews: readStep(e.id, "review") ?? {},
  };
}

/** Deletes edits trashed before `before`, with their steps. Returns how many went. */
export async function purgeEdits(before: number): Promise<number> {
  const gone = allEdits().filter((e) => e.trashedAt && e.trashedAt < before);
  for (const e of gone) {
    libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(e.id);
    await rm(path.dirname(fileOf(e.id)), { recursive: true, force: true });
  }
  return gone.length;
}
