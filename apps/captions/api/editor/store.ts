import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { isLanguage } from "../../contracts/voice";
import { BUILT_IN_BUNDLE, EDIT_FEEDBACK_MAX, EDIT_FEEDBACK_TEXT_MAX, EDIT_SLOTS, MAX_MOMENTS, MAX_VERSIONS, MOMENT_SHAPES, PIP_CORNERS, type MomentShape, type PipCorner, type EditIntro, type Edit, type EditBundle, type EditItem, type EditorDefaults, type EditSlot, type Timeline, type EditBrief, type EditVoice, type EditFeedback, type EditJob, type EditSummary, type Line, type ReviewPreview, type Sentence, type VersionMark, type VersionPlan } from "../../contracts/editor";
import { env } from "../lib/env";
import { listInstalled, packOn } from "../lib/packs";
import { pluginEditFlags } from "../lib/plugin";
import type { EditStepChoice } from "../../contracts/editor-steps";
import type { EditStyleCopy, WorkingSize } from "../../contracts/editor-styles";
import type { Coverage, Critique, EditPlan } from "../../contracts/edit-plan";
import { cardsView, readCards } from "./cards/state";
import { downloadsAsk, waitLine } from "./reach";
import { passesView } from "./passes";
import { chosenSteps } from "./steps";
import { lineOf } from "./progress";
import { progressOf } from "../work/place";
import { deviceName } from "../lib/devices";
import { findStyle, rememberStyle, styleCopy } from "./styles";
import type { Cdl } from "./grade";
import { accountOf, givenLibrary, homeOf, libraryRole } from "../library/access";
import { readerOf } from "../library/reader";
import { assetRef, canSee } from "../library/sources";
import { sharedTo } from "../lib/project-of";
import { ownedProjects, sharedProjects } from "../lib/workshop/workspace";
import { ownedTeamWithMembers } from "../lib/workspaces";
import { libraryDb } from "../library/db";
import { enqueueJob } from "../library/jobs";
import { writeJsonAtomic } from "../library/media/run";
import { libraryHasSounds } from "../library/sfx";
import { pluginsOffIn } from "../lib/plugin-workspaces";
import { currentWorkspaceId } from "../lib/workspace-scope";
import { findUser, pictureOf, type SessionUser } from "../users";
import { tallyInto, type Tally } from "../lib/mac-claude";
import type { PairMatch, Roll } from "./sync";

/**
 * The AI Editor's edits: $DATA_DIR/editor/<id>/edit.json (what the user asked for), and its steps in the library
 * database's `edit_jobs` (version_id "<id>:<variant>"). An edit is in the workspace of the library its footage is in
 * and shared there (editRole): everyone given that workspace sees it, and makes its next version with their own AI.
 */

export interface EditMeta extends EditBrief {
  id: string;
  workspaceId: string;
  /** the project (the brand) it was made in; one made before edits had one is the first brand's (lib/project-of.ts) */
  projectId?: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  sources: string[];
  /** clips still uploading from a phone, in the order picked; when the last is in they become `sources` and the edit starts */
  uploads?: { id: string; version?: string }[];
  /** per source version, set on the edit page (PUT eyeline) */
  eyeline?: Record<string, number>;
  /** the items the edit was made with, recorded by createEdit and never changed by a later default */
  bundle: EditBundle;
  /** the post-processing steps it was made with (Settings → AI Editor at the time), run by post.ts */
  steps?: EditStepChoice[];
  /** the editing style it was made with, as it was then (styles.ts); an edit made with none has no such key */
  style?: EditStyleCopy;
  /** the working size its style named (timeline.ts); absent or null = the footage's own */
  size?: WorkingSize | null;
  /** which of the name and the brief came through an AI's tool, not from the person at their own screen (routes.ts): finished.ts keeps neither */
  byTool?: ("name" | "brief")[];
  /** what the person said about its versions, word for word, oldest first (contracts/editor.ts EditFeedback) */
  feedback?: EditFeedback[];
  /** the person said to cut now (editor_run now): the plan takes the files the Media Library has ready and names the rest */
  now?: boolean;
  /** by version name: the name the person gave it and when it was deleted on the project page (PATCH versions/:name) */
  marks?: Record<string, VersionMark>;
  trashedAt?: number;
}

/** Each per-edit flag a loaded plug-in declares, at its default (off when it has none). */
export const defaultFlags = (): Record<string, boolean> => Object.fromEntries(pluginEditFlags().map((f) => [f.id, f.default === true]));

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const root = () => path.join(env.dataDir, "editor");
export const editDir = (id: string) => path.join(root(), id);
const fileOf = (id: string) => path.join(editDir(id), "edit.json");
export const MAX_SOURCES = 50;

/** The edit, trashed or not; null for an id that is no edit. */
/** The name of an edit nobody named: the script step gives it the video's first line (script.ts). */
export const UNNAMED = "Untitled edit";

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

/**
 * Adds what the person said to the edit's notes, word for word (cut only at EDIT_FEEDBACK_TEXT_MAX), oldest first. A
 * note it holds already (same words, place, version and author) is not added twice; past EDIT_FEEDBACK_MAX the oldest
 * go. Returns how many were added.
 */
export async function addFeedback(id: string, notes: EditFeedback[]): Promise<number> {
  const e = readEdit(id);
  if (!e) return 0;
  const had = e.feedback ?? [];
  const same = (a: EditFeedback, b: EditFeedback) => a.from === b.from && a.text === b.text && a.t === b.t && a.variant === b.variant && a.by === b.by;
  const add: EditFeedback[] = [];
  for (const n of notes) {
    const note = { ...n, text: n.text.slice(0, EDIT_FEEDBACK_TEXT_MAX) };
    if (note.text.trim() && ![...had, ...add].some((x) => same(x, note))) add.push(note);
  }
  if (add.length) await saveEdit({ ...e, feedback: [...had, ...add].slice(-EDIT_FEEDBACK_MAX) });
  return add.length;
}

/**
 * Queues the edit's next version from its notes: the script again (the footage is analyzed first when it never was).
 * It runs as `actor`: whoever asked for it (in a shared workspace, the teammate whose note it is).
 */
export const queueVersion = (e: EditMeta, actor: string | null = e.createdBy) =>
  enqueueJob(libraryDb(), e.workspaceId, `${e.id}:`, readStep(e.id, "analysis") ? "script" : "analyze", actor, true, "edit_jobs");

/**
 * Whose note from chat no script or plan step was given: the author of the newest one sent while the edit was being
 * made, after that run's script had started. Undefined with none, and for an edit whose script never ran with this
 * record (StepFiles.read).
 */
export function unreadNote(id: string): string | undefined {
  const read = readStep(id, "read");
  return read ? (readEdit(id)?.feedback ?? []).filter((n) => n.from === "chat" && n.at > read.at).at(-1)?.by : undefined;
}

/** The version made last (its draft written most recently): what a note in chat is about. */
export function newestDraft(id: string): string | undefined {
  const at = (n: string) => statSync(path.join(editDir(id), "drafts", `${n}.json`)).mtimeMs;
  return draftNames(id).filter((n) => n.startsWith("v")).sort((a, b) => at(b) - at(a))[0];
}

/** What the steps found, each in its own file beside edit.json, so a step never overwrites a change the user made meanwhile. */
export interface StepFiles {
  /** `eyeline`: per source version, the eye line found on this computer (eyeline.ts) */
  /** `rolls`: per camera take, its separate mic and second cameras, found by their sound (sync.ts rollsOf) */
  /** `pairs`: each pair compared by sound, "a~b" → where a's 0 s is in b, or null for no match */
  analysis: { sentences: Sentence[]; notes: string[]; eyeline?: Record<string, number>; rolls?: Record<string, Roll>; pairs?: Record<string, PairMatch | null> };
  /** `at`: when it was made; `coverage`: what footage a planned edit's cut was made from (plan.ts) */
  plan: { lines: Line[]; plans: VersionPlan[]; notes: string[]; at?: number; coverage?: Coverage };
  /** each version's preview in Review (preview.ts) */
  review: Record<string, ReviewPreview>;
  /** each version's post-processing (post.ts): the copies its steps made, by source version id, and their notes */
  post: Record<string, { files: Record<string, string>; notes: string[] }>;
  /** each version's lines and takes as the script step first planned them, before the person changed any (finished.ts: what they took out) */
  first: { plans: Pick<VersionPlan, "name" | "lines">[] };
  /** the person took this edit off its style's finished list: it is never kept for a style again (finished.ts) */
  finished: { removed: boolean };
  /** the passes Carry on queued for each version, in order (passes.ts) */
  passes: Record<string, string[]>;
  /** each planned version's plan as checked and repaired, and what was changed (plan.ts) */
  shots: Record<string, PlannedVersion>;
  /** the newest note from chat the last script or plan step was given (its `at`, 0 with none): a later one is unread (worker.ts) */
  read: { at: number };
  /** the Audio Enhancer sessions of its recordings' voices, by source version id, then enhancer (voice-mix.ts) */
  voice: Record<string, Record<string, string>>;
  /** what each step's AI calls spent, by job id, every run of it added up (spending) */
  usage: Record<string, Tally>;
}

/** A planned version's plan (plan.ts). */
export interface PlannedVersion {
  plan: EditPlan;
  notes: string[];
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

/** Said when a version's newest post step did not finish (failed, stopped, or not done yet). */
export const POST_UNFINISHED = "Post-processing did not finish on this version: run it again before exporting";

/**
 * True when a version's newest post step is not done: its copies (post.json) are an older run's, which may carry faces
 * unblurred or a look the cut no longer has, so neither the export nor a preview may play them. A version that never
 * had a post step (edits from before it) is not held.
 */
export function postUnfinished(editId: string, variant: string): boolean {
  const row = libraryDb().prepare("SELECT state FROM edit_jobs WHERE edit_id = ? AND version_id = ? AND kind = 'post' ORDER BY id DESC LIMIT 1").get(editId, `${editId}:${variant}`) as { state: string } | undefined;
  return !!row && row.state !== "done";
}

export const saveStep = <K extends keyof StepFiles>(id: string, name: K, value: StepFiles[K]) => writeJsonAtomic(path.join(root(), id, `${name}.json`), value);

/** A version's draft as the draft step saved it: drafts/<name>.json. */
export interface DraftFile {
  timeline: Timeline;
  notes: string[];
  /** a planned version's cut as the AI made it: it waits for the look before Review (critique.ts) */
  due?: 1;
  /** the look at this cut before Review: the shots that don't hold up */
  critique?: Critique;
  /** the look, or the fix after it, could not be made (a usage limit, no AI connected, a failure): the cut went to
   *  Review as it was, and this line says so on its Review version (critique.ts) */
  unchecked?: string;
}

/** A draft's name: a version (v1…) or a moment of a long recording (m1…m20, moments.ts). Nothing else is a file name here. */
const DRAFT = /^(v[1-9]|m[1-9]\d?)$/;

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

/** Writes what a step learned about a draft into it, with no new revision: the cut is the same (critique.ts). */
export const markDraft = (id: string, name: string, d: DraftFile) => writeJsonAtomic(path.join(editDir(id), "drafts", `${name}.json`), d);

/**
 * The timeline a Review version was rendered from (filed/<video>.<n>.json): what that version's timeline in Review
 * names with its keys, so edits made there are cut into this timeline and no later one.
 */
export interface FiledCut {
  variant: string;
  timeline: Timeline;
}
const filedPath = (id: string, assetId: string, n: number) => path.join(editDir(id), "filed", `${assetId}.${n}.json`);
const FILED_ASSET = /^[\w-]{1,64}$/;

export async function saveFiled(id: string, assetId: string, n: number, cut: FiledCut): Promise<void> {
  await mkdir(path.dirname(filedPath(id, assetId, n)), { recursive: true });
  await writeJsonAtomic(filedPath(id, assetId, n), cut);
}

export function readFiled(id: string, assetId: string, n: number): FiledCut | null {
  if (!FILED_ASSET.test(assetId) || !Number.isInteger(n) || n < 1) return null;
  try {
    return JSON.parse(readFileSync(filedPath(id, assetId, n), "utf8")) as FiledCut;
  } catch {
    return null;
  }
}

/** The names of the edit's drafts, in order. */
export function draftNames(id: string): string[] {
  try {
    return readdirSync(path.join(editDir(id), "drafts"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((n) => DRAFT.test(n))
      // by number, so m2 comes before m10
      .sort((a, b) => a[0]!.localeCompare(b[0]!) || Number(a.slice(1)) - Number(b.slice(1)));
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

/**
 * Who `username` is to the edit (out of the trash): "owner" when its workspace is theirs, "member" when the team's
 * owner gave them the workspace it is in (Settings → Team → Access, read fresh), else null: they don't see it. Whether
 * they may change it is the AI Editor's Read & write (boot.ts WRITE_GATES); renaming and deleting are mayRename's.
 */
export async function editRole(username: string, e: EditMeta | null): Promise<"owner" | "member" | null> {
  if (!e || e.trashedAt) return null;
  if (e.workspaceId === homeOf(username)) return "owner";
  const owner = accountOf(e.workspaceId);
  return owner && (await sharedTo({ username } as SessionUser, owner, e.projectId)) ? "member" : null;
}

/** Rename and delete: the edit's maker, or its workspace's owner. */
export const mayRename = (username: string, e: EditMeta, role: Awaited<ReturnType<typeof editRole>>): boolean => role === "owner" || e.createdBy === username;

/**
 * The account the edit's workspace is: its grade, styles, skills, context and Review are that account's, never the
 * maker's own (a member's edit is in the team owner's). An edit with no workspace id (a test's) is its maker's; a
 * workspace id no account has is its own name, as homeOf gives most accounts.
 */
export const ownerOf = (e: Pick<EditMeta, "createdBy"> & { workspaceId?: string }): string =>
  !e.workspaceId || homeOf(e.createdBy) === e.workspaceId ? e.createdBy : (accountOf(e.workspaceId) ?? e.workspaceId);

/** A version's library, asset and workspace, while its asset is out of the trash. */
const libraryOf = (versionId: string) =>
  libraryDb()
    .prepare(
      `SELECT l.id AS library_id, l.workspace_id, a.id AS asset_id FROM asset_versions v JOIN assets a ON a.id = v.asset_id
       JOIN libraries l ON l.id = a.library_id WHERE v.id = ? AND a.trashed_at IS NULL AND a.left_hidden_at IS NULL`,
    )
    .get(versionId) as { library_id: string; workspace_id: string; asset_id: string } | undefined;

/**
 * Whether `username` may see the clip as the Media Library's own routes would show it (library/routes.ts
 * libraryMedia): they read its library (readerOf), and for anyone but its owner every policy of its source says yes
 * (sources.ts canSee: a plug-in's gate, say one that shows a member only blurred footage). Its owner is never stopped here.
 */
export async function seesClip(username: string, versionId: string, row = libraryOf(versionId)): Promise<boolean> {
  const viewer = row ? await readerOf(username, row.library_id) : null;
  return !!row && !!viewer && (viewer.role === "owner" || (await canSee(viewer, assetRef(row.library_id, row.asset_id, versionId))));
}

/**
 * The workspace the versions' libraries are in, when they are all `username`'s own (out of the trash, in one
 * workspace). Null otherwise: the caller answers 404, as for a version that does not exist.
 */
export function sourcesWorkspace(username: string, versionIds: string[]): string | null {
  let ws: string | null = null;
  for (const id of versionIds) {
    const row = libraryOf(id);
    if (!row || !libraryRole(username, row.library_id) || (ws && ws !== row.workspace_id)) return null;
    ws = row.workspace_id;
  }
  return ws;
}

/** sourcesWorkspace, also for footage in a workspace the team's owner gave `username` (givenLibrary): what an edit is made from. */
export async function editSources(username: string, versionIds: string[]): Promise<string | null> {
  let ws: string | null = null;
  for (const id of versionIds) {
    const row = libraryOf(id);
    if (!row || (ws && ws !== row.workspace_id) || !(await seesClip(username, id, row))) return null;
    ws = row.workspace_id;
  }
  return ws;
}

/** Every library clip the edit uses: its footage, its song, its intro and each draft's B-roll (a timeline's sources but the edit's own files). */
export function clipsOf(e: EditMeta): string[] {
  const out = new Set([...e.sources, ...(e.song ? [e.song] : []), ...(e.intro ? [e.intro.source, ...(e.intro.reaction ? [e.intro.reaction] : [])] : [])]);
  for (const n of draftNames(e.id)) for (const [id, s] of Object.entries(readDraft(e.id, n)?.timeline.sources ?? {})) if (!s.file) out.add(id);
  return [...out];
}

/**
 * Whether `username` may make, change, run or watch the edit: its workspace is theirs, or they may see every clip it
 * uses (seesClip). A teammate refused one clip gets the not-found the library gives for it.
 */
export async function seesEdit(username: string, e: EditMeta): Promise<boolean> {
  if (e.workspaceId === homeOf(username)) return true;
  const ids = clipsOf(e);
  return !ids.length || (await editSources(username, ids)) === e.workspaceId;
}

const BUILT_IN_ITEMS: Record<EditSlot, EditItem[]> = {
  designSystem: [{ id: "plain", title: "Plain", from: null }],
  grade: [{ id: "none", title: "No grade", from: null }],
  voiceMix: [{ id: "level", title: "Level only", from: null }],
  sfxSet: [
    { id: "library", title: "From my library", from: null },
    { id: "none", title: "No sound effects", from: null },
  ],
};

/**
 * One account's default choices, one file: $DATA_DIR/editor-defaults/<username>.json. `by` holds each workspace's own
 * (its id → the slots chosen there). The slots beside it are the ones chosen before the defaults were per workspace:
 * what a request with no workspace still reads and writes (a person with none).
 */
type Chosen = Partial<EditBundle> & { by?: Record<string, Partial<EditBundle>> };
const defaultsFile = (username: string) => path.join(env.dataDir, "editor-defaults", `${username}.json`);
const USER = /^[a-zA-Z0-9._-]{1,64}$/;

function keptDefaults(username: string): Chosen {
  try {
    return JSON.parse(readFileSync(defaultsFile(username), "utf8")) as Chosen;
  } catch {
    return {};
  }
}

/**
 * What the account chose in `workspace`. The first read since the defaults became per workspace gives every workspace
 * the account has then what it had chosen before, so nothing changes until one is changed; a workspace made later has
 * no entry and starts from the app's defaults.
 */
export async function chosenDefaults(username: string, workspace?: string): Promise<Partial<EditBundle>> {
  if (!USER.test(username)) return {};
  const { by, ...before } = keptDefaults(username);
  if (!workspace) return before;
  if (by || !Object.keys(before).length) return { ...by?.[workspace] };
  const have = [...(await ownedProjects(username)), ...(await sharedProjects(username))];
  const seeded = Object.fromEntries(have.map((p) => [p.id, { ...before }]));
  await writeJsonAtomic(defaultsFile(username), { ...before, by: seeded });
  return { ...seeded[workspace] };
}

/** Sets the account's default for one slot in `workspace` to an item, or clears it (null) back to the pack's or the built-in one. */
export async function setChosenDefault(username: string, slot: EditSlot, id: string | null, workspace?: string): Promise<void> {
  if (!USER.test(username)) throw new Error("Bad account name");
  const chosen = await chosenDefaults(username, workspace);
  if (id === null) delete chosen[slot];
  else chosen[slot] = id;
  // read again: the read above may have just given each workspace its starting values
  const { by } = keptDefaults(username);
  await mkdir(path.dirname(defaultsFile(username)), { recursive: true });
  await writeJsonAtomic(defaultsFile(username), workspace ? { ...keptDefaults(username), by: { ...by, [workspace]: chosen } } : { ...chosen, ...(by ? { by } : {}) });
}

/**
 * The installed packs an edit may use: switched on and not delisted. The editor is not per project, so a pack limited
 * to some projects still counts; its project scope is cleared before packOn checks it.
 */
const usablePacks = async (username: string) => (await listInstalled(username)).filter((p) => packOn({ ...p, projectId: undefined, projectIds: undefined }));

/**
 * The editor defaults of one account in `workspace`: the items each slot can take (built-in, then its installed
 * packs'), the choices made in that workspace, and the set a new edit there gets. For each slot that set is the choice,
 * else the first installed pack's default for it, else the built-in item; a choice or default naming an item no longer
 * installed is skipped. No `workspace`: the account's choices from before they were per workspace.
 */
export async function editorDefaults(username: string, workspace?: string): Promise<EditorDefaults> {
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
  const chosen = await chosenDefaults(username, workspace);
  const bundle = { ...BUILT_IN_BUNDLE };
  // sound effects: "From my library" is the default once the workspace's library has some; the built-in is "No sound effects"
  const sfxDefault = (await libraryHasSounds(username, workspace)) ? "library" : BUILT_IN_BUNDLE.sfxSet;
  for (const slot of EDIT_SLOTS) {
    const candidates = [chosen[slot], ...packs.map((p) => p.editorDefaults?.[slot])];
    bundle[slot] = candidates.find((id): id is string => !!id && items[slot].some((i) => i.id === id)) ?? (slot === "sfxSet" ? sfxDefault : BUILT_IN_BUNDLE[slot]);
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

/** A collection `username` may read in workspace `ws`, for B-roll: their own library's, or one given to them. */
async function collectionOk(username: string, ws: string, id: string): Promise<boolean> {
  const row = libraryDb().prepare("SELECT l.id, l.workspace_id FROM collections c JOIN libraries l ON l.id = c.library_id WHERE c.id = ?").get(id) as
    | { id: string; workspace_id: string }
    | undefined;
  return !!row && row.workspace_id === ws && (!!libraryRole(username, row.id) || (await givenLibrary(username, row.id)));
}

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : undefined);
const num = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);

/** The brief fields of a body, cleaned; a field that is absent or of the wrong type is left out. Throws on a B-roll collection the user can't read. */
export async function cleanBrief(body: Record<string, unknown>, username: string, ws: string): Promise<Partial<EditBrief>> {
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
  // short videos from a long recording: how many to find. Kept only when asked for, so every other edit is as it was
  const moments = num(body.moments, 0, MAX_MOMENTS);
  if (moments !== undefined && Math.round(moments) >= 1) out.moments = Math.round(moments);
  if (typeof body.shape === "string" && Object.hasOwn(MOMENT_SHAPES, body.shape)) out.shape = body.shape as MomentShape;
  if (body.brollCollectionId === null) out.brollCollectionId = null;
  else if (typeof body.brollCollectionId === "string") {
    if (!(await collectionOk(username, ws, body.brollCollectionId))) throw new NoCollection("B-roll folder not found");
    out.brollCollectionId = body.brollCollectionId;
  }
  // null or [] = its workspace's language again (none there: the person's own list); anything not a list of codes is ignored
  if (body.languages === null) out.languages = [];
  else if (Array.isArray(body.languages) && body.languages.every(isLanguage)) out.languages = [...new Set(body.languages as string[])].slice(0, 5);
  // planned from the brief, not cut around speech (plan.ts); kept only when asked for, so every other edit is as it was
  if (body.plan === true) out.plan = true;
  else if (body.plan === false) out.plan = false;
  // a song the person may read in this workspace; anything else is left out
  if (body.song === null) out.song = null;
  else if (typeof body.song === "string" && (await editSources(username, [body.song])) === ws) out.song = body.song;
  // an intro whose clips the person may read in this workspace; anything else is left out
  if (body.intro === null) out.intro = null;
  else if (body.intro && typeof body.intro === "object" && typeof (body.intro as EditIntro).source === "string") {
    const b = body.intro as Record<string, unknown>;
    const ids = [b.source as string, ...(typeof b.reaction === "string" ? [b.reaction] : [])];
    if ((await editSources(username, ids)) === ws) {
      const seconds = num(b.seconds, 3, 300);
      out.intro = {
        source: ids[0]!,
        ...(seconds !== undefined ? { seconds: Math.round(seconds) } : {}),
        ...(ids[1] ? { reaction: ids[1] } : {}),
        ...(typeof b.corner === "string" && (PIP_CORNERS as readonly string[]).includes(b.corner) ? { corner: b.corner as PipCorner } : {}),
      };
    }
  }
  const voice = cleanVoice(body.voice);
  if (voice) out.voice = voice;
  const punch = num((body.framing as { punch?: unknown } | undefined)?.punch, 1, 2);
  if (punch !== undefined) out.framing = { punch };
  // only the flags a loaded plug-in declares, each one a boolean; the others are ignored
  if (body.flags && typeof body.flags === "object" && !Array.isArray(body.flags)) {
    const given = body.flags as Record<string, unknown>;
    out.flags = Object.fromEntries(pluginEditFlags().flatMap((f) => (typeof given[f.id] === "boolean" ? [[f.id, given[f.id] as boolean]] : [])));
  }
  return out;
}

const FX = /^(off|[a-z][a-z0-9]{1,20})$/;
/** An EditVoice from a body, or undefined: an enhancer id (checked when the voice is made), recordings' picks and shares. */
export function cleanVoice(v: unknown): EditVoice | undefined {
  const x = v as { fx?: unknown; per?: unknown; mix?: unknown } | null;
  if (!x || typeof x !== "object" || typeof x.fx !== "string" || !FX.test(x.fx)) return undefined;
  const pairs = (o: unknown) => (o && typeof o === "object" && !Array.isArray(o) ? Object.entries(o).slice(0, MAX_SOURCES) : []);
  const per = Object.fromEntries(pairs(x.per).filter(([, f]) => typeof f === "string" && FX.test(f)));
  const mix = Object.fromEntries(pairs(x.mix).flatMap(([k, m]) => (typeof m === "number" && Number.isFinite(m) ? [[k, Math.round(Math.min(1, Math.max(0, m)) * 20) / 20]] : [])));
  return { fx: x.fx, ...(Object.keys(per).length ? { per } : {}), ...(Object.keys(mix).length ? { mix } : {}) };
}

/**
 * EditMeta.byTool once `patch` set the name or the brief: a field an AI's tool wrote (`tool`) is listed, one the person
 * wrote themselves is theirs again. No key when neither is a tool's.
 */
export function byToolAfter(was: EditMeta["byTool"], patch: Partial<EditBrief>, tool: boolean): Pick<EditMeta, "byTool"> {
  const set = (["name", "brief"] as const).filter((k) => patch[k] !== undefined);
  const now = [...(was ?? []).filter((k) => !set.includes(k)), ...(tool ? set : [])];
  return now.length ? { byTool: now } : {};
}

/** An editing style that is not there: the routes answer 404. */
export class NoStyle extends Error {}

/**
 * What an editing style gives an edit in workspace `ws`: its choices, and the copy the edit keeps. `username` is the
 * account the workspace is (ownerOf): the style and grades are its. A B-roll folder the edit cannot read and a grade
 * that account no longer has are left out, not an error. `on` is an edit that already exists (PATCH): where the style
 * names no folder or grade, that edit keeps its own. `workspace`: the one a new edit is made in (its defaults).
 */
export async function styleFields(username: string, ws: string, id: string, on?: Pick<EditMeta, "bundle" | "brollCollectionId">, workspace?: string): Promise<Partial<EditMeta>> {
  const s = findStyle(username, id);
  if (!s) throw new NoStyle("Editing style not found");
  const d = await editorDefaults(username, workspace);
  return {
    versions: s.versions,
    targetS: s.targetS,
    framing: { punch: s.punch },
    brollCollectionId: s.brollCollectionId && (await collectionOk(username, ws, s.brollCollectionId)) ? s.brollCollectionId : (on?.brollCollectionId ?? null),
    bundle: { ...(on?.bundle ?? d.bundle), ...(s.grade && d.items.grade.some((i) => i.id === s.grade) ? { grade: s.grade } : {}) },
    ...(s.steps ? { steps: s.steps } : {}),
    // always set, so a style that names none takes another style's size off an edit
    size: s.size ?? null,
    style: styleCopy(s),
  };
}

/** The workspace of uploads `username` started and has not finished, all in one; null otherwise. */
async function uploadsWorkspace(username: string, uploadIds: string[]): Promise<string | null> {
  let ws: string | null = null;
  for (const id of uploadIds) {
    const row = libraryDb()
      .prepare("SELECT u.library_id, l.workspace_id FROM uploads u JOIN libraries l ON l.id = u.library_id WHERE u.id = ? AND u.created_by = ? AND u.state IN ('open', 'finishing')")
      .get(id, username) as { library_id: string; workspace_id: string } | undefined;
    if (!row || (ws && ws !== row.workspace_id)) return null;
    if (!libraryRole(username, row.library_id) && !(await givenLibrary(username, row.library_id))) return null;
    ws = row.workspace_id;
  }
  return ws;
}

// ponytail: one chain for every waiting edit (edit.json is read, changed and written); per-edit chains if phones ever queue many at once
let waiting = Promise.resolve();

/** Runs `fn` on that chain: a read, change and write of edit.json there never crosses an upload finishing (PATCH). */
export function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = waiting.then(fn);
  waiting = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * An upload finished as `versionId`: the edit waiting on it notes that, and once its last clip is in, its clips become
 * its sources and it starts (the phone that picked them need not be open). Edits are found by a scan of all of them.
 */
export function uploadFinished(uploadId: string, versionId: string): Promise<void> {
  waiting = waiting.then(async () => {
    const e = allEdits().find((x) => !x.trashedAt && x.uploads?.some((u) => u.id === uploadId));
    if (!e) return;
    const uploads = e.uploads!.map((u) => (u.id === uploadId ? { ...u, version: versionId } : u));
    if (uploads.some((u) => !u.version)) return void (await saveEdit({ ...e, uploads }));
    const { uploads: _, ...rest } = e;
    // footage added while it waited (PATCH addSources) stays with the uploads'
    await saveEdit({ ...rest, sources: [...new Set([...uploads.map((u) => u.version!), ...e.sources])] });
    enqueueJob(libraryDb(), e.workspaceId, `${e.id}:`, "analyze", e.createdBy, true, "edit_jobs");
  }).catch((err) => console.error("editor: an edit waiting on uploads", err));
  return waiting;
}

/** The plug-ins off in the workspace a new edit is made in (its own, else the one the request works in): their steps are left out. `owner`: whose workspace it is. */
async function stepsOffIn(username: string, owner: string, projectId?: string): Promise<string[]> {
  const ws = projectId ?? (await currentWorkspaceId({ username } as SessionUser));
  return ws ? ((await pluginsOffIn([{ id: ws, owner }]))[ws] ?? []) : [];
}

/**
 * A new edit of `sources` for `username`, or null when a source is not theirs to read. `tool`: an AI's tool made it, so
 * its name and brief are not the person's own words. Footage of a workspace the team's owner gave them makes an edit
 * in that workspace only (`projectId` must be it), with that workspace's defaults, plug-in steps and styles (ownerOf).
 */
export async function createEdit(username: string, body: Record<string, unknown>, tool = false, projectId?: string, emptyIn?: string): Promise<EditMeta | null> {
  const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((s): s is string => typeof s === "string"))] : []);
  // `emptyIn`: an edit with no footage yet in that workspace (POST /api/editor/empty): clips are put on its timeline by hand
  const sources = emptyIn ? [] : ids(body.sources);
  const uploads = sources.length || emptyIn ? [] : ids(body.uploads);
  const count = sources.length || uploads.length;
  if ((!count && !emptyIn) || count > MAX_SOURCES) return null;
  const ws = emptyIn ?? (sources.length ? await editSources(username, sources) : await uploadsWorkspace(username, uploads));
  if (!ws) return null;
  const account = ws === homeOf(username) ? username : accountOf(ws);
  // a member's edit is in the given workspace it was asked in, so it shows there and nowhere else
  if (!account || (account !== username && !(projectId && (await sharedTo({ username } as SessionUser, account, projectId))))) return null;
  const now = Date.now();
  const brief = await cleanBrief(body, username, ws);
  // `style` names an editing style: its choices go under the request's own. No `style` key at all: none, as before.
  const styled = typeof body.style === "string" ? await styleFields(account, ws, body.style, undefined, projectId) : {};
  const e: EditMeta = {
    id: randomUUID(),
    workspaceId: ws,
    ...(projectId ? { projectId } : {}),
    createdBy: username,
    createdAt: now,
    updatedAt: now,
    sources,
    ...(uploads.length ? { uploads: uploads.map((id) => ({ id })) } : {}),
    name: UNNAMED,
    brief: "",
    script: "",
    versions: 1,
    targetS: 0,
    brollCollectionId: null,
    framing: { punch: 1.15 },
    bundle: (await editorDefaults(account, projectId)).bundle,
    steps: chosenSteps(account, await stepsOffIn(username, account, projectId)),
    ...styled,
    ...brief,
    flags: { ...defaultFlags(), ...brief.flags },
    ...byToolAfter(undefined, brief, tool),
  };
  mkdirSync(path.dirname(fileOf(e.id)), { recursive: true });
  await saveEdit(e);
  // New edit opens on the style used last; an explicit null (None picked there) forgets it
  if (e.style || body.style === null) rememberStyle(username, e.style?.id ?? null);
  return e;
}

let usageChain: Promise<unknown> = Promise.resolve();
/**
 * Runs one step of an edit with its AI calls added to its job's spend (usage.json beside the edit), also when it fails or
 * waits. Written on one chain: an edit's versions run their steps side by side.
 */
export async function spending<T>(job: { id: number; version_id: string | null }, fn: () => Promise<T>): Promise<T> {
  const used: Tally = { calls: 0, tokens: 0, costUsd: 0 };
  try {
    return await tallyInto(used, fn);
  } finally {
    const id = (job.version_id ?? "").split(":")[0]!;
    if (used.calls && readEdit(id)) {
      usageChain = usageChain.then(async () => {
        const all = readStep(id, "usage") ?? {};
        const had = all[job.id] ?? { calls: 0, tokens: 0, costUsd: 0 };
        all[job.id] = { calls: had.calls + used.calls, tokens: had.tokens + used.tokens, costUsd: had.costUsd + used.costUsd };
        await saveStep(id, "usage", all);
      }).catch((e) => console.warn(`[editor] usage ${id}: ${e}`));
      await usageChain;
    }
  }
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
  const rows = libraryDb().prepare("SELECT id, version_id, kind, state, attempts, error, actor, device FROM edit_jobs WHERE edit_id = ? ORDER BY id").all(id) as unknown as Array<JobDbRow & { actor: string | null; device: string | null }>;
  const spent = readStep(id, "usage") ?? {};
  return rows.map((r) => {
    // running on a computer: what it last said (work/place.ts), else which computer holds it
    const p = r.state === "running" ? progressOf(r.id) : undefined;
    const progress = p ? { device: p.device, done: p.done, total: p.total, leftS: p.leftS } : r.state === "running" && r.device ? { device: deviceName(r.device) } : undefined;
    // queued: why no computer has taken it, when none that runs it can read its files (reach.ts)
    const line = r.state === "running" ? (p?.line ?? lineOf(r.id)) : r.state === "queued" && r.actor ? waitLine(r.actor, r) : undefined;
    // queued with no reader and a server copy to download: the chat asks to turn Downloads on (reach.ts downloadsAsk)
    const downloads = r.state === "queued" && r.actor ? downloadsAsk(r) : undefined;
    const usage = spent[r.id];
    // the cards step of an edit in passes waits on its look sheet for the person's go (cards/step.ts)
    const st = r.kind === "cards" && r.state === "queued" ? readCards(id, r.version_id.slice(id.length + 1)) : null;
    const sheet = st?.sheet && !st.go ? { at: st.sheet.at } : undefined;
    return { id: r.id, kind: r.kind, variant: r.version_id.slice(id.length + 1), state: r.state, attempts: r.attempts, error: r.error, ...(line ? { line } : {}), ...(progress ? { progress } : {}), ...(downloads ? { downloads } : {}), ...(usage ? { usage } : {}), ...(sheet ? { sheet } : {}) };
  });
}

export function summaryOf(e: EditMeta): EditSummary {
  // a step the person stopped is saved as failed with "Stopped" (worker.ts): `stopped` keeps it off Home's failed list
  const row = libraryDb().prepare("SELECT kind, state, error = 'Stopped' AS stopped FROM edit_jobs WHERE edit_id = ? ORDER BY id DESC LIMIT 1").get(e.id) as
    { kind: EditJob["kind"]; state: EditJob["state"]; stopped: number | null } | undefined;
  const last = row ? { kind: row.kind, state: row.state, ...(row.stopped ? { stopped: true as const } : {}) } : null;
  const costUsd = Object.values(readStep(e.id, "usage") ?? {}).reduce((n, u) => n + u.costUsd, 0);
  return { id: e.id, name: e.name, createdBy: e.createdBy, ...makerOf(e), createdAt: e.createdAt, updatedAt: e.updatedAt, sources: e.sources, ...(e.uploads ? { uploads: e.uploads } : {}), last, ...(costUsd ? { costUsd } : {}) };
}

/** Who made it, by name and picture, where the edit's workspace has a team: one person's own edits carry none. */
function makerOf(e: EditMeta): Pick<EditSummary, "maker"> {
  if (!ownedTeamWithMembers(ownerOf(e))) return {};
  const u = findUser(e.createdBy);
  return { maker: { name: nameOf(e.createdBy), picture: u ? pictureOf(u) : null } };
}

const nameOf = (username: string) => findUser(username)?.displayName || username;

export function viewOf(e: EditMeta): Edit {
  const { trashedAt: _, ...meta } = e;
  delete meta.byTool; // the server's own mark (finished.ts): `meta` is this call's own copy
  const a = readStep(e.id, "analysis");
  const p = readStep(e.id, "plan");
  const cards = cardsView(e.id, draftNames(e.id));
  const jobs = jobsOf(e.id);
  const passes = passesView(e, draftNames(e.id), jobs.some((j) => j.state === "queued" || j.state === "running"));
  return {
    ...meta,
    ...summaryOf(e),
    jobs,
    eyeline: e.eyeline ?? {},
    ...(a?.eyeline ? { eyelineFound: a.eyeline } : {}),
    drafts: draftNames(e.id),
    sentences: a?.sentences.length ?? 0,
    lines: p?.lines ?? [],
    plans: p?.plans ?? [],
    notes: [...(a?.notes ?? []), ...(p?.notes ?? [])],
    ...(p?.coverage ? { coverage: p.coverage } : {}),
    previews: readStep(e.id, "review") ?? {},
    ...askedBy(e),
    flagDefs: pluginEditFlags(),
    ...(cards ? { cards } : {}),
    ...(passes ? { passes } : {}),
  };
}

/** Who asked for each version's newest cut, by name, where the workspace has a team (summaryOf's `maker`). */
function askedBy(e: EditMeta): Pick<Edit, "askedBy"> {
  const filed = Object.entries(readStep(e.id, "review") ?? {}).filter(([, p]) => p.by);
  return filed.length && ownedTeamWithMembers(ownerOf(e)) ? { askedBy: Object.fromEntries(filed.map(([v, p]) => [v, nameOf(p.by!)])) } : {};
}

/** Deletes edits trashed before `before`, with their steps. Returns how many went. */
export async function purgeEdits(before: number): Promise<number> {
  const gone = allEdits().filter((e) => e.trashedAt && e.trashedAt < before);
  for (const e of gone) await purgeEdit(e.id);
  return gone.length;
}

/** Deletes one edit for good, with its steps and files (stop its work first: worker.ts stopEdit). */
export async function purgeEdit(id: string): Promise<void> {
  libraryDb().prepare("DELETE FROM edit_jobs WHERE edit_id = ?").run(id);
  await rm(path.dirname(fileOf(id)), { recursive: true, force: true });
}
