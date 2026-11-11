import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { BUILT_IN_BUNDLE, EDIT_SLOTS, MAX_VERSIONS, type Edit, type EditBundle, type EditItem, type EditorDefaults, type EditSlot, type Timeline, type EditBrief, type EditJob, type EditSummary, type Line, type ReviewPreview, type Sentence, type VersionPlan } from "../../contracts/editor";
import { env } from "../lib/env";
import { listInstalled, packOn } from "../lib/packs";
import { pluginEditFlags } from "../lib/plugin";
import type { EditStepChoice } from "../../contracts/editor-steps";
import { chosenSteps } from "./steps";
import type { Cdl } from "./grade";
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
  /** the items the edit was made with, recorded by createEdit and never changed by a later default */
  bundle: EditBundle;
  /** the post-processing steps it was made with (Settings → AI Editor at the time), run by post.ts */
  steps?: EditStepChoice[];
  trashedAt?: number;
}

/** Each per-edit flag a loaded plug-in declares, at its default (off when it has none). */
export const defaultFlags = (): Record<string, boolean> => Object.fromEntries(pluginEditFlags().map((f) => [f.id, f.default === true]));

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const root = () => path.join(env.dataDir, "editor");
export const editDir = (id: string) => path.join(root(), id);
const fileOf = (id: string) => path.join(editDir(id), "edit.json");
const MAX_SOURCES = 50;

/** The edit, trashed or not; null for an id that is no edit. */
export function readEdit(id: string): EditMeta | null {
  if (!ID.test(id)) return null;
  try {
    const e = JSON.parse(readFileSync(fileOf(id), "utf8")) as EditMeta;
    // edits saved before the recorded set or the flags read as built-in, and with each flag at its default
    return { ...e, bundle: { ...BUILT_IN_BUNDLE, ...e.bundle }, flags: { ...defaultFlags(), ...e.flags } };
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
  /** each version's post-processing (post.ts): the copies its steps made, by source version id, and their notes */
  post: Record<string, { files: Record<string, string>; notes: string[] }>;
}

export function readStep<K extends keyof StepFiles>(id: string, name: K): StepFiles[K] | null {
  try {
    return JSON.parse(readFileSync(path.join(root(), id, `${name}.json`), "utf8")) as StepFiles[K];
  } catch {
    return null;
  }
}

/** The copies the post step made for a version, by source version id: the preview and the export play these (none: the sources' own files). */
export const postFiles = (editId: string, variant: string): Record<string, string> => readStep(editId, "post")?.[variant]?.files ?? {};

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

/**
 * Saves a version's draft. A draft already there is kept, not overwritten: it moves to the next revision (`<name>.r<n>.json`,
 * which draftNames and readDraft do not list), so a re-run's result is a new revision and the one it replaced survives.
 */
export async function saveDraft(id: string, name: string, d: DraftFile): Promise<void> {
  const dir = path.join(editDir(id), "drafts");
  await mkdir(dir, { recursive: true });
  const cur = path.join(dir, `${name}.json`);
  if (existsSync(cur)) {
    const n = readdirSync(dir).filter((f) => f.startsWith(`${name}.r`)).length + 1;
    await rename(cur, path.join(dir, `${name}.r${n}.json`));
  }
  await writeJsonAtomic(cur, d);
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

const BUILT_IN_ITEMS: Record<EditSlot, EditItem[]> = {
  designSystem: [{ id: "plain", title: "Plain", from: null }],
  grade: [{ id: "none", title: "No grade", from: null }],
  voiceMix: [{ id: "level", title: "Level only", from: null }],
  sfxSet: [{ id: "none", title: "No sound effects", from: null }],
};

/** One person's default choices, one file per account: $DATA_DIR/editor-defaults/<username>.json. */
const defaultsFile = (username: string) => path.join(env.dataDir, "editor-defaults", `${username}.json`);
const USER = /^[a-zA-Z0-9._-]{1,64}$/;

export function chosenDefaults(username: string): Partial<EditBundle> {
  if (!USER.test(username)) return {};
  try {
    return JSON.parse(readFileSync(defaultsFile(username), "utf8")) as Partial<EditBundle>;
  } catch {
    return {};
  }
}

/** Sets the person's default for one slot to an item, or clears it (null) back to the pack's or the built-in one. */
export async function setChosenDefault(username: string, slot: EditSlot, id: string | null): Promise<void> {
  if (!USER.test(username)) throw new Error("Bad account name");
  const chosen = chosenDefaults(username);
  if (id === null) delete chosen[slot];
  else chosen[slot] = id;
  await mkdir(path.dirname(defaultsFile(username)), { recursive: true });
  await writeJsonAtomic(defaultsFile(username), chosen);
}

/**
 * The installed packs an edit may use: switched on and not delisted. The editor is not per project, so a pack limited
 * to some projects still counts; its project scope is cleared before packOn checks it.
 */
const usablePacks = async (username: string) => (await listInstalled(username)).filter((p) => packOn({ ...p, projectId: undefined, projectIds: undefined }));

/**
 * The editor defaults of one person: the items each slot can take (built-in, then their installed packs'), their own
 * choices, and the set a new edit gets. For each slot that set is the person's choice, else the first installed pack's
 * default for it, else the built-in item; a choice or default naming an item no longer installed is skipped.
 */
export async function editorDefaults(username: string): Promise<EditorDefaults> {
  const items = structuredClone(BUILT_IN_ITEMS);
  const packs = await usablePacks(username);
  for (const p of packs) {
    const add = (slot: EditSlot, list?: { name: string; title: string }[]) => {
      for (const i of list ?? []) if (!items[slot].some((x) => x.id === i.name)) items[slot].push({ id: i.name, title: i.title, from: p.name });
    };
    add("grade", p.grades);
    add("voiceMix", p.voiceMixes);
    add("sfxSet", p.sfxSets);
  }
  const chosen = chosenDefaults(username);
  const bundle = { ...BUILT_IN_BUNDLE };
  for (const slot of EDIT_SLOTS) {
    const candidates = [chosen[slot], ...packs.map((p) => p.editorDefaults?.[slot])];
    bundle[slot] = candidates.find((id): id is string => !!id && items[slot].some((i) => i.id === id)) ?? BUILT_IN_BUNDLE[slot];
  }
  return { bundle, chosen, items };
}

/**
 * The colour grade an edit was made with, as CDL maths for the preview and the OTIO. The built-in "none" and a grade
 * the creator no longer has installed both give undefined (no grade).
 */
export async function gradeOf(username: string, bundle: EditBundle): Promise<Cdl | undefined> {
  if (bundle.grade === BUILT_IN_BUNDLE.grade) return undefined;
  for (const p of await usablePacks(username)) {
    const g = p.grades?.find((x) => x.name === bundle.grade);
    if (g) return g.cdl;
  }
  return undefined;
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
  // only the flags a loaded plug-in declares, each one a boolean; the others are ignored
  if (body.flags && typeof body.flags === "object" && !Array.isArray(body.flags)) {
    const given = body.flags as Record<string, unknown>;
    out.flags = Object.fromEntries(pluginEditFlags().flatMap((f) => (typeof given[f.id] === "boolean" ? [[f.id, given[f.id] as boolean]] : [])));
  }
  return out;
}

/** A new edit of `sources` for `username`, or null when a source is not theirs to read. */
export async function createEdit(username: string, body: Record<string, unknown>): Promise<EditMeta | null> {
  const sources = Array.isArray(body.sources) ? [...new Set(body.sources.filter((s): s is string => typeof s === "string"))] : [];
  if (!sources.length || sources.length > MAX_SOURCES) return null;
  const ws = sourcesWorkspace(username, sources);
  if (!ws) return null;
  const now = Date.now();
  const brief = cleanBrief(body, username, ws);
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
    bundle: (await editorDefaults(username)).bundle,
    steps: chosenSteps(username),
    ...brief,
    flags: { ...defaultFlags(), ...brief.flags },
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
    flagDefs: pluginEditFlags(),
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
