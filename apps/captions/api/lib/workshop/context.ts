import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { KnowledgeSource } from "../../../contracts/knowledge";
import { SOUNDS } from "../../../contracts/library";
import { inProjectOf, projectOf } from "../project-of";
import type { SessionUser } from "../../users";
import { env } from "../env";
import { renderInstructions } from "./prompt";
import { asKnowledge } from "./sources";
import type { KnowledgeFile, Project } from "./types";
import { okId } from "./validate";
import { onFor } from "./workspace";
import { ask, onComputer } from "../../work/on-computer";

/**
 * A workspace's context, carried to every AI that works in it (the chat, the Media Library, the AI Editor, a connected
 * AI): its instructions and the context files added to it (the Workshop's Knowledge sources kept to it or to every
 * workspace, minus the ones it switched off), each read and filed once (fileSource, workshop.ts). One-shot calls get
 * workspaceContext: the instructions and what each file is, cut to what the call can carry. An AI with tools reads a
 * file's text itself (the workspace_files tool).
 */

const ROOT = path.join(env.dataDir, "workshop");

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

/** A workspace by its id, whoever owns it; null when there is none. */
export const readWorkspace = (id: string | undefined): Promise<Project | null> =>
  id && okId(id) ? readJson<Project>(path.join(ROOT, "projects", `${id}.json`)) : Promise.resolve(null);

/**
 * The sources a workspace's AI reads: its owner's kept to it or to every workspace, minus the ones it switched off.
 * `all` is the owner's sources when the caller has them (the Workshop's list, which moves old project files in first).
 */
export async function workspaceSources(p: Project, all?: KnowledgeSource[]): Promise<KnowledgeSource[]> {
  if (!all) {
    const dir = path.join(ROOT, "sources");
    const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
    all = (await Promise.all(names.map((n) => readJson<KnowledgeSource>(path.join(dir, n))))).filter((s): s is KnowledgeSource => !!s);
  }
  return onFor(
    all.filter((s) => s.owner === p.owner && (!s.projectId || s.projectId === p.id)).sort((a, b) => a.createdAt - b.createdAt),
    p,
  );
}

/** The workspace's context files with their text, as the Workshop's prompts read them. */
export async function workspaceKnowledge(p: Project, all?: KnowledgeSource[]): Promise<KnowledgeFile[]> {
  const sources = await workspaceSources(p, all);
  const text = (id: string) => readFile(path.join(ROOT, "sources", `${id}.txt`), "utf-8").catch(() => "");
  // a project's files from before Knowledge, not moved in yet (the Workshop moves them on its first list)
  return [...(p.knowledge ?? []), ...(await Promise.all(sources.map(async (s) => asKnowledge(s, await text(s.id)))))];
}

/** One line per context file: its id, what it is and what it answers. */
export function filesIndex(files: Array<Pick<KnowledgeFile, "id" | "name" | "title" | "kind" | "about" | "uses">>): string {
  return files
    .map((f) => {
      const head = `- ${f.title || f.name}${f.kind ? ` (${f.kind})` : ""} [${f.id}]`;
      const about = f.about ? `: ${f.about.replace(/\s+/g, " ").trim()}` : ": not read yet";
      const uses = f.uses?.length ? ` Answers: ${f.uses.join("; ")}` : "";
      return `${head}${about}${uses}`;
    })
    .join("\n");
}

/**
 * What a one-shot AI call is told of the workspace: its instructions, then what each context file is, in `max`
 * characters. The instructions take what they need up to two thirds; the files the rest, whole lines only.
 */
export function renderContext(p: Project, files: KnowledgeFile[], max: number): string {
  const LIST = "\n\nContext files added to the workspace:\n";
  const MARK = "\n…[shortened]";
  const head = renderInstructions(p);
  const room = max - Math.min(head.length, Math.floor((max * 2) / 3)) - LIST.length;
  const lines: string[] = [];
  let used = 0;
  for (const line of filesIndex(files).split("\n")) {
    if (!line || used + line.length + 1 > room) break;
    lines.push(line);
    used += line.length + 1;
  }
  const list = lines.length ? `${LIST}${lines.join("\n")}` : "";
  const cut = max - list.length;
  return `${head.length <= cut ? head : `${head.slice(0, cut - MARK.length).trimEnd()}${MARK}`}${list}`;
}

/**
 * The workspace's context for a one-shot call (above); "" when there is no such workspace. The files' own text is not
 * read: a line a file needs only what it was filed as.
 */
export async function workspaceContext(projectId: string | undefined, max: number): Promise<string> {
  const p = await readWorkspace(projectId);
  if (!p) return "";
  return renderContext(p, [...(p.knowledge ?? []), ...(await workspaceSources(p)).map((s) => asKnowledge(s, ""))], max);
}

/**
 * The workspace a thing `username` made is in, by the thing's own `projectId`: that one while they own it or it is
 * given to them, else their first brand (project-of.ts), so a thing from before workspaces, or a member's thing in a
 * workspace taken away since, reads the same workspace everywhere. Undefined for a person with no workspace.
 */
export async function workspaceOf(username: string, projectId?: string): Promise<string | undefined> {
  return (await projectOf({ username } as SessionUser))?.(projectId);
}

/**
 * The stamp of a text written under `context` (what workspaceContext gave the call that wrote it) by the prompt version
 * `salt`: a short hash of both. A writer stamps with the text it sent, never with a second read.
 */
export const stampOf = (context: string, salt = ""): string => createHash("sha256").update(`${salt}\n${context}`).digest("hex").slice(0, 16);

/**
 * Which context a stored text would be written under now: the stamp (stampOf) of exactly what
 * `workspaceContext(projectId, max)` gives. A library description or shot description keeps the stamp it was written
 * with; when the workspace's instructions or files change what that call reads, the stamp differs and the text is
 * written again when an edit uses the file or the person opens the clip (tasks/flywheel/PLAN.md, 6.1). A change past
 * what the call reads (beyond `max`) leaves the stamp alone.
 */
export async function contextStamp(projectId: string | undefined, max: number, salt = ""): Promise<string> {
  return stampOf(await workspaceContext(projectId, max), salt);
}

/** "1 h 41 min", "12 min", "40 s". */
const span = (s: number) => (s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${Math.round(s)} s`);
const many = (n: number, one: string, more: string) => `${n} ${n === 1 ? one : more}`;

/** A video kind as a count: "12 gameplay recordings", "3 screen recordings", "4 product close-ups". */
function kindCount(n: number, kind: string): string {
  if (/recording$/.test(kind)) return `${n} ${n === 1 ? kind : `${kind}s`}`;
  if (/s$/.test(kind)) return `${n} ${kind}`;
  return `${n} ${kind} ${n === 1 ? "recording" : "recordings"}`;
}

/** Video kinds named one by one in the footage profile; the rest are counted together. */
const PROFILE_KINDS = 8;

/**
 * What footage a workspace holds, in one line for an AI that plans work there (the chat, the AI Editor): its
 * libraries' videos by what they are (the description's kind, A-roll as talking takes) with their length, then songs,
 * sound effects and photos. "Footage here: 12 gameplay recordings (1 h 41 min), 2 songs, no talking takes." Finished
 * work and the trash are left out. "" when the workspace has no footage.
 */
export async function footageProfile(projectId: string | undefined): Promise<string> {
  if (onComputer.on) return ask("footageProfile");
  const p = await readWorkspace(projectId);
  if (!p) return "";
  const inP = await inProjectOf({ username: p.owner } as SessionUser, p.id);
  if (!inP) return "";
  // read when asked: the library is a big module, and this file is read by every workspace prompt
  const [{ libraryDb }, { homeOf }, { FINISHED }] = await Promise.all([import("../../library/db"), import("../../library/access"), import("../../library/query")]);
  const rows = libraryDb()
    .prepare(
      `SELECT a.kind, a.roll, json_extract(v.probe, '$.duration') AS dur, json_extract(l.settings, '$.projectId') AS ws,
         (SELECT d.kind FROM descriptions d WHERE d.version_id = v.id AND d.source = 'ai') AS what,
         EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?) AS song,
         EXISTS (SELECT 1 FROM asset_tags t WHERE t.asset_id = a.id AND t.tag = ?) AS effect
       FROM assets a JOIN asset_versions v ON v.id = a.current_version_id JOIN libraries l ON l.id = a.library_id
       WHERE l.workspace_id = ? AND a.trashed_at IS NULL AND NOT ${FINISHED}`,
    )
    .all(SOUNDS.music.tag, SOUNDS.effect.tag, homeOf(p.owner)) as { kind: string; roll: string | null; dur: number | null; ws: string | null; what: string | null; song: number; effect: number }[];
  const kinds = new Map<string, { n: number; s: number }>();
  let talking = { n: 0, s: 0 };
  let songs = 0;
  let effects = 0;
  let photos = 0;
  let sounds = 0;
  for (const r of rows) {
    if (!inP(r.ws ?? undefined)) continue;
    if (r.song) songs++;
    else if (r.effect) effects++;
    else if (r.kind === "image") photos++;
    else if (r.kind === "audio") sounds++;
    else if (r.kind === "video") {
      const s = Number(r.dur) || 0;
      if (r.roll === "a") talking = { n: talking.n + 1, s: talking.s + s };
      else {
        const k = kinds.get(r.what ?? "") ?? { n: 0, s: 0 };
        kinds.set(r.what ?? "", { n: k.n + 1, s: k.s + s });
      }
    }
  }
  if (!talking.n && !kinds.size && !songs && !effects && !photos && !sounds) return "";
  const named = [...kinds].filter(([k]) => k).sort((x, y) => y[1].s - x[1].s);
  const rest = [...named.slice(PROFILE_KINDS).map(([, v]) => v), ...(kinds.has("") ? [kinds.get("")!] : [])].reduce((t, v) => ({ n: t.n + v.n, s: t.s + v.s }), { n: 0, s: 0 });
  const parts = [
    ...named.slice(0, PROFILE_KINDS).map(([k, v]) => `${kindCount(v.n, k)} (${span(v.s)})`),
    ...(rest.n ? [`${many(rest.n, named.length ? "other video" : "video", named.length ? "other videos" : "videos")} (${span(rest.s)})`] : []),
    ...(songs ? [many(songs, "song", "songs")] : []),
    ...(effects ? [many(effects, "sound effect", "sound effects")] : []),
    ...(sounds ? [many(sounds, "sound recording", "sound recordings")] : []),
    ...(photos ? [many(photos, "photo", "photos")] : []),
    talking.n ? `${many(talking.n, "talking take", "talking takes")} (${span(talking.s)})` : "no talking takes",
  ];
  return `Footage here: ${parts.join(", ")}.`;
}
