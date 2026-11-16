import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_VERSIONS } from "../../contracts/editor";
import type { EditStepChoice } from "../../contracts/editor-steps";
import {
  LEARNED_MAX,
  LEARNED_PROMPT_MAX,
  MAX_EDITING_STYLES,
  PACES,
  PLAYBOOK_MAX,
  PUNCHES,
  STYLE_NAME_MAX,
  STYLE_NOTES_MAX,
  type AnimationStyle,
  type EditingStyle,
  type EditingStyleInput,
  type EditingStylesView,
  type EditStyleCopy,
  type Pace,
  cutLine,
  type StyleLearned,
  type StylePlaybook,
  WORKING_SIZES,
} from "../../contracts/editor-styles";
import { env } from "../lib/env";
import { pluginEditorSteps } from "../lib/plugin";
import { libraryRole } from "../library/access";
import { libraryDb } from "../library/db";
import { ownerOf, type EditMeta } from "./store";

/**
 * Editing styles (contracts/editor-styles.ts): one file per account, $DATA_DIR/editor-styles/<username>.json, holding
 * `editing` (the styles) and `last` (the one the last new edit was made with). Other keys in that file are kept as
 * they are. A style is what the person typed and chose. Two parts are kept apart from that and never mixed into it: the
 * playbook an AI researched (marked as such until the person changes it) and what finished edits taught (finished.ts
 * keepLearned, the person's own lines and numbers measured by code). What an edit does with a style is in store.ts
 * (styleFields), script.ts and plan.ts (styleLayers) and timeline.ts (the pace).
 */

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const fileOf = (username: string) => path.join(env.dataDir, "editor-styles", `${username}.json`);

export interface Saved {
  last?: string;
  /** New edit's "How do you like to work?" was answered */
  asked?: true;
  editing: EditingStyle[];
  /** the ElevenLabs voice used last, by id (voice.ts) */
  voice?: string;
  /** the person's animation styles (animation-styles.ts) */
  animation?: AnimationStyle[];
  /** the person's carousel styles, for the Designer: the same kind of collection (animation-styles.ts) */
  carousel?: AnimationStyle[];
  [other: string]: unknown;
}

export function read(username: string): Saved {
  try {
    if (!USER.test(username)) throw new Error("Bad account name");
    const f = JSON.parse(readFileSync(fileOf(username), "utf8")) as Saved;
    return { ...f, editing: Array.isArray(f.editing) ? f.editing : [] };
  } catch {
    return { editing: [] };
  }
}

/** Read, change and write with nothing awaited in between, so two requests of one account never lose each other's change. */
export function change<T>(username: string, fn: (f: Saved) => T): T {
  if (!USER.test(username)) throw new Error("Bad account name");
  const f = read(username);
  const out = fn(f);
  if (typeof out === "string") return out; // refused: nothing to write
  const file = fileOf(username);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(f, null, 2));
  renameSync(`${file}.tmp`, file);
  return out;
}

export function stylesView(username: string): EditingStylesView {
  const f = read(username);
  return { styles: f.editing, last: f.editing.some((s) => s.id === f.last) ? f.last! : null, ...(f.asked ? { asked: true as const } : {}) };
}

/** "How do you like to work?" is not shown again (its Not now). */
export const markAsked = (username: string): void =>
  change(username, (f) => {
    f.asked = true;
  });

export const findStyle = (username: string, id: string): EditingStyle | null => read(username).editing.find((s) => s.id === id) ?? null;

/** The style the next New edit opens with: the one just used, or none. */
export const rememberStyle = (username: string, id: string | null): void =>
  change(username, (f) => {
    if (id) f.last = id;
    else delete f.last;
  });

/** What a new style has when nothing is said: the choices a plain new edit gets. */
const PLAIN: Omit<EditingStyle, "id" | "name" | "createdAt" | "updatedAt"> = { notes: "", versions: 1, targetS: 0, pace: "tight", punch: 1.15, grade: null, brollCollectionId: null, steps: null };

/** The nearest of the three punch-ins a style can have (an edit's own zoom can be any number). */
const punchOf = (n: number): number => PUNCHES.map((p) => p.value).reduce((a, b) => (Math.abs(b - n) < Math.abs(a - n) ? b : a));

/** A Media Library folder the person can read, in any library of theirs. */
function folderOk(username: string, id: string): boolean {
  const row = libraryDb().prepare("SELECT library_id FROM collections WHERE id = ?").get(id) as { library_id: string } | undefined;
  return !!row && !!libraryRole(username, row.library_id);
}

const MAX_STEPS = 20;
const short = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

/**
 * A style's steps, in the shape an edit keeps them. A step this app has gets a value for each of its options (the one
 * sent when it is one the option takes, else the option's default); one it does not have is kept as sent, and an edit
 * made with the style skips it with a note, as an edit does.
 */
function cleanSteps(given: unknown): EditStepChoice[] | string {
  if (!Array.isArray(given) || given.length > MAX_STEPS) return `steps is a list of at most ${MAX_STEPS}`;
  const loaded = pluginEditorSteps();
  const out: EditStepChoice[] = [];
  for (const g of given as { id?: unknown; values?: unknown }[]) {
    if (!g || !short(g.id, 100) || !g.id || out.some((x) => x.id === g.id)) return "Each step has its own id";
    const sent = g.values && typeof g.values === "object" && !Array.isArray(g.values) ? (g.values as Record<string, unknown>) : {};
    const st = loaded.find((s) => s.id === g.id);
    const values = st
      ? Object.fromEntries(
          (st.options ?? []).map((o) => {
            const v = sent[o.id];
            const ok = short(v, 2000) && (o.kind !== "choice" || !!o.choices?.some((c) => c.value === v));
            return [o.id, ok ? (v as string) : o.default];
          }),
        )
      : Object.fromEntries(Object.entries(sent).filter(([k, v]) => k.length <= 100 && short(v, 2000)).slice(0, MAX_STEPS)) as Record<string, string>;
    out.push({ id: g.id, values });
  }
  return out;
}

/** The style fields a body carries, checked. A string is what is wrong with it. */
function clean(username: string, body: Record<string, unknown>): EditingStyleInput | string {
  const out: EditingStyleInput = {};
  if (body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return "Give the style a name";
    if (name.length > STYLE_NAME_MAX) return `A style's name is at most ${STYLE_NAME_MAX} characters`;
    out.name = name;
  }
  if (body.notes !== undefined) {
    if (typeof body.notes !== "string") return "notes is text";
    const notes = body.notes.trim();
    if (notes.length > STYLE_NOTES_MAX) return `The notes are at most ${STYLE_NOTES_MAX} characters`;
    out.notes = notes;
  }
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (body.versions !== undefined) {
    if (!num(body.versions)) return "versions is a number";
    out.versions = Math.round(Math.min(MAX_VERSIONS, Math.max(1, body.versions as number)));
  }
  if (body.targetS !== undefined) {
    if (!num(body.targetS)) return "targetS is a number of seconds";
    out.targetS = Math.round(Math.min(3600, Math.max(0, body.targetS as number)));
  }
  if (body.pace !== undefined) {
    if (!PACES.includes(body.pace as Pace)) return `pace is one of ${PACES.join(", ")}`;
    out.pace = body.pace as Pace;
  }
  if (body.punch !== undefined) {
    if (!num(body.punch)) return "punch is a number";
    out.punch = punchOf(body.punch as number);
  }
  if (body.grade !== undefined) {
    if (body.grade !== null && (!short(body.grade, 200) || !body.grade)) return "grade is a grade's id, or null";
    out.grade = body.grade as string | null;
  }
  if (body.brollCollectionId !== undefined) {
    if (body.brollCollectionId !== null && (typeof body.brollCollectionId !== "string" || !folderOk(username, body.brollCollectionId))) return "No such folder in your Media Library";
    out.brollCollectionId = body.brollCollectionId as string | null;
  }
  if (body.steps !== undefined) {
    const steps = body.steps === null ? null : cleanSteps(body.steps);
    if (typeof steps === "string") return steps;
    out.steps = steps;
  }
  if (body.animation !== undefined) {
    if (body.animation !== null && !read(username).animation?.some((a) => a.id === body.animation)) return "No such animation style";
    out.animation = body.animation as string | null;
  }
  // one of the person's skills, by id; one that is not there (or is switched off) when an edit's script step runs adds nothing
  if (body.skill !== undefined) {
    if (body.skill !== null && (!short(body.skill, 100) || !body.skill)) return "skill is a skill's id, or null";
    out.skill = body.skill as string | null;
  }
  if (body.size !== undefined) {
    const z = body.size as { w?: unknown; h?: unknown } | null;
    const known = z && WORKING_SIZES.find((s) => s.w === z.w && s.h === z.h);
    if (z !== null && !known) return `size is null (the footage's own) or one of ${WORKING_SIZES.map((s) => `${s.w}x${s.h}`).join(", ")}`;
    out.size = known ? { w: known.w, h: known.h } : null;
  }
  if (body.passes !== undefined) {
    if (typeof body.passes !== "boolean") return "passes is true or false";
    out.passes = body.passes;
  }
  if (body.playbook !== undefined) {
    const p = cleanPlaybook(body.playbook);
    if (typeof p === "string") return p;
    out.playbook = p;
  }
  return out;
}

const PLAYBOOK_SOURCES = 20;

/** A playbook as sent: null or no text takes it off. `by` is the route's word for who sent it (routes.ts); anything else reads as an AI's. */
export function cleanPlaybook(v: unknown): StylePlaybook | null | string {
  if (v === null) return null;
  const p = v as { text?: unknown; sources?: unknown; by?: unknown };
  if (!p || typeof p !== "object" || typeof p.text !== "string") return "playbook is { text, sources }, or null";
  const text = p.text.trim();
  if (!text) return null;
  if (text.length > PLAYBOOK_MAX) return `The playbook is at most ${PLAYBOOK_MAX} characters`;
  const given = p.sources === undefined ? [] : p.sources;
  if (!Array.isArray(given) || given.length > PLAYBOOK_SOURCES) return `sources is a list of at most ${PLAYBOOK_SOURCES}`;
  const sources: StylePlaybook["sources"] = [];
  for (const g of given as { title?: unknown; url?: unknown }[]) {
    if (!g || !short(g.url, 2000) || !/^https?:\/\/\S+$/i.test(g.url)) return "Each source is { title, url }, its url a web address";
    sources.push({ title: String(g.title ?? "").trim().slice(0, 200), url: g.url });
  }
  return { text, sources, at: Date.now(), by: p.by === "person" ? "person" : "ai" };
}

/**
 * A new style from the fields sent, or from an edit of the person's own (`from`): its choices are copied (versions,
 * target length, pace, punch-in, grade, B-roll folder, steps, working size, and the notes of the style it was made
 * with), never its brief, script or footage. `first`: New edit's "How do you like to work?" made it, so it is the one
 * New edit opens on and that screen is not shown again. A string is why it was refused.
 */
export function createStyle(username: string, body: Record<string, unknown>, from?: EditMeta, first = false): EditingStyle | string {
  const given = clean(username, body);
  if (typeof given === "string") return given;
  if (!given.name) return "Give the style a name";
  const base = from
    ? { notes: from.style?.notes ?? "", versions: from.versions, targetS: from.targetS, pace: from.style?.pace ?? "tight", punch: punchOf(from.framing.punch), grade: from.bundle.grade, brollCollectionId: from.brollCollectionId, steps: from.steps ?? null, size: from.size ?? null, ...(from.style?.animation ? { animation: from.style.animation } : {}), ...(from.style?.skill ? { skill: from.style.skill } : {}), ...(from.style?.passes ? { passes: true } : {}) }
    : PLAIN;
  const now = Date.now();
  const style: EditingStyle = { ...base, ...given, name: given.name, id: randomUUID(), createdAt: now, updatedAt: now };
  return change(username, (f) => {
    if (f.editing.length >= MAX_EDITING_STYLES) return `You have ${MAX_EDITING_STYLES} editing styles, the most an account keeps. Delete one first.`;
    f.editing.push(style);
    if (first) {
      f.last = style.id;
      f.asked = true;
    }
    return style;
  });
}

/** Changes the fields sent. Null: no such style. A string is why it was refused. */
export function updateStyle(username: string, id: string, body: Record<string, unknown>): EditingStyle | string | null {
  const given = clean(username, body);
  if (typeof given === "string") return given;
  return change(username, (f) => {
    const at = f.editing.findIndex((s) => s.id === id);
    if (at < 0) return null;
    return (f.editing[at] = { ...f.editing[at]!, ...given, updatedAt: Date.now() });
  });
}

/** False: no such style. */
export const deleteStyle = (username: string, id: string): boolean =>
  change(username, (f) => {
    const n = f.editing.length;
    f.editing = f.editing.filter((s) => s.id !== id);
    if (f.last === id) delete f.last;
    return f.editing.length < n;
  });

/** What an edit keeps of its style. */
export const styleCopy = (s: EditingStyle): EditStyleCopy => ({ id: s.id, name: s.name, notes: s.notes, pace: s.pace, ...(s.animation ? { animation: s.animation } : {}), ...(s.skill ? { skill: s.skill } : {}), ...(s.passes ? { passes: true as const } : {}) });

/**
 * The one block an edit's style adds to the script step's prompt, after the installed packs' text: the person's own
 * notes, marked as theirs. Nothing for an edit with no style, or a style with no notes. Cut to the caps here too, so
 * a file changed by hand can never send more. With the edit (`now`: the plan and script steps), what the style as it
 * is now adds after the notes too (styleLayers); a style with no playbook and nothing learned adds nothing more.
 */
export function styleBlock(style: EditStyleCopy | undefined, now?: Pick<EditMeta, "id" | "createdBy" | "projectId"> & { workspaceId?: string }): string {
  return now ? styleLayers({ ...now, style }) : notesBlock(style);
}

const notesBlock = (style: Pick<EditStyleCopy, "name" | "notes"> | undefined): string => {
  const notes = (style?.notes ?? "").trim().slice(0, STYLE_NOTES_MAX);
  return notes ? `Editing style ${JSON.stringify(String(style!.name).slice(0, STYLE_NAME_MAX))}, in the author's own words:\n${notes}` : "";
};

/* ---- a style that learns (tasks/flywheel stage 5): its playbook and what finished edits taught ---- */

/** × on one of the style's learned entries, for good: the edit is kept on the style's `unlearned`, so approving it again
 * teaches nothing (finished.ts keepLearned). False: no such style or entry. */
export const removeLearned = (username: string, styleId: string, editId: string): boolean =>
  change(username, (f) => {
    const s = f.editing.find((x) => x.id === styleId);
    if (!s?.learned?.some((l) => l.editId === editId)) return false;
    s.learned = s.learned.filter((l) => l.editId !== editId);
    s.unlearned = [...(s.unlearned ?? []), editId];
    return true;
  });

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

export const LEARNED_INTRO = "From edits the author approved in this style, in this workspace. Examples of their taste, not rules: the brief and the footage of this edit decide.";

/** The playbook as a prompt reads it, marked as researched, cut to its cap; nothing without one. */
function playbookBlock(p: StylePlaybook | null | undefined): string {
  const text = (p?.text ?? "").trim().slice(0, PLAYBOOK_MAX);
  if (!text) return "";
  return `${p!.by === "person" ? "Researched reference for this kind of edit, as the author keeps it" : "Researched reference for this kind of edit, written from research and not by the author (their notes and the brief come first)"}:\n${text}`;
}

/**
 * Learned entries as a prompt reads them: the approved cuts' numbers, then the author's own lines word for word, newest
 * first, whole lines while they fit in LEARNED_PROMPT_MAX (a newest line longer than that alone is cut). Nothing for none.
 */
export function learnedBlock(list: StyleLearned[]): string {
  const cuts = list.filter((l) => l.cut.shots > 0).map((l) => cutLine(l.cut));
  const lines: string[] = [];
  let used = 0;
  for (const t of list.flatMap((l) => [...l.notes].reverse())) {
    const line = `- ${oneLine(t)}`;
    const need = line.length + (lines.length ? 1 : 0);
    if (used + need > LEARNED_PROMPT_MAX) {
      if (!lines.length) lines.push(clip(line, LEARNED_PROMPT_MAX));
      break;
    }
    lines.push(line);
    used += need;
  }
  if (!cuts.length && !lines.length) return "";
  return [
    LEARNED_INTRO,
    cuts.length > 0 && `Cuts the author approved in this style here: ${cuts.join("; ")}.`,
    lines.length > 0 && `What the author said about them on the way, word for word, newest first:\n${lines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * What an edit's style adds to its plan and script steps: the notes of the copy it was made with (styleBlock), then,
 * from the style as it is now, its playbook and what edits approved in it taught in the edit's own workspace (the edit
 * itself left out). A style with neither gives styleBlock's text exactly. The workspace is the brand (`projectId`; an
 * edit with none matches entries of edits with none), never the library's `workspaceId`.
 */
export function styleLayers(edit: Pick<EditMeta, "id" | "createdBy" | "projectId"> & { workspaceId?: string; style?: EditStyleCopy }): string {
  // the style is the workspace's (store.ts ownerOf), also on an edit a teammate made
  return layersOf(edit.style, edit.style ? findStyle(ownerOf(edit), edit.style.id) : null, edit);
}

/**
 * styleLayers' text for a style kept somewhere else (a plug-in's own editor keeps its styles): the notes of the copy the
 * edit was made with, then the style as it is now (`now`): its playbook and what approved edits taught in the edit's own
 * workspace, the edit itself left out.
 */
export function layersOf(
  copy: Pick<EditStyleCopy, "name" | "notes"> | undefined,
  now: Pick<EditingStyle, "playbook" | "learned"> | null | undefined,
  edit: { id: string; projectId?: string },
): string {
  const here = (now?.learned ?? []).filter((l) => l.workspaceId === (edit.projectId ?? "") && l.editId !== edit.id).slice(0, LEARNED_MAX);
  return [notesBlock(copy), playbookBlock(now?.playbook), learnedBlock(here)].filter(Boolean).join("\n\n");
}

/**
 * The footage profile's second line: what was finished in a workspace, from the learned entries of all the person's
 * styles: `Finished here: 3 "Hard edit" edits, 22 to 25 s.` Empty with none.
 */
export function finishedProfile(username: string, workspaceId: string): string {
  const parts = read(username)
    .editing.map((s) => {
      const here = (s.learned ?? []).filter((l) => l.workspaceId === workspaceId);
      const secs = here.map((l) => l.cut.seconds).filter((n) => n > 0);
      const lo = Math.min(...secs);
      const hi = Math.max(...secs);
      return { n: here.length, text: `${here.length} ${JSON.stringify(s.name)} edit${here.length === 1 ? "" : "s"}${secs.length ? `, ${lo === hi ? lo : `${lo} to ${hi}`} s` : ""}` };
    })
    .filter((p) => p.n > 0)
    .sort((a, b) => b.n - a.n);
  return parts.length ? `Finished here: ${parts.map((p) => p.text).join("; ")}.` : "";
}
