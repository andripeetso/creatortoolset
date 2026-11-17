import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ToolFolders } from "../../contracts/folders";
import { changeFolders } from "../folders";
import { env } from "../lib/env";
import { announce } from "../lib/sync";

/**
 * One project per video on the Editor list: every edit of one video sits in that video's folder of the folder store
 * (`/api/folders/editor`). An edit is of the same video as another in its workspace when its name is the other's without
 * a version or a length ("… 25s v4", "… 25s", "…"), or it is cut from the same files. Filed when an edit is made and once
 * over the edits already there. Never moved: an edit in any folder, and one this filed before that was taken out again (`filed`).
 */

/** "v3", "V4", "(v2)", "version 5" at the end of an edit's name. */
export const VERSION_TAIL = /\s*[-–,(]?\s*\b(?:v|version\s*)\d+\)?\s*$/i;
/** "25s", "60 sec", "(30s)" at the end: a length of the same video. */
const LENGTH_TAIL = /\s*[-–,(]?\s*\b\d+(?:\.\d+)?\s*(?:s|secs?|seconds?)\)?\s*$/i;

/** The video's own name: without its version and its length ("Cartwheel Basics 25s v4" → "Cartwheel Basics"). */
export const videoName = (name: string) => name.trim().replace(VERSION_TAIL, "").trim().replace(LENGTH_TAIL, "").trim().replace(VERSION_TAIL, "").trim() || name.trim();

export interface Groupable {
  id: string;
  name: string;
  projectId?: string;
  sources?: string[];
  createdAt: number;
}

/**
 * Files the loose edits of one video into its folder, in `d` (one person's editor folders, changed in place): the folder
 * an edit of that video is in already (the newest one's), else a new one named by the video, made only when two or more
 * go in. `filed`: edit → folder this has put it in, added to. True when anything changed.
 */
export function groupEdits(edits: Groupable[], d: ToolFolders, filed: Record<string, string>, newId: () => string = randomUUID): boolean {
  const keysOf = (e: Groupable) => {
    const ws = e.projectId ?? "";
    const src = e.sources?.length ? [...e.sources].sort().join("\n") : "";
    return [`${ws}\nname\n${videoName(e.name).toLowerCase()}`, ...(src ? [`${ws}\nsrc\n${src}`] : [])];
  };
  // edits joined by any key they share (a name, or the footage): one group per video
  let groups: { keys: Set<string>; edits: Groupable[] }[] = [];
  for (const e of edits) {
    const keys = keysOf(e);
    const hit = groups.filter((g) => keys.some((k) => g.keys.has(k)));
    groups = groups.filter((g) => !hit.includes(g));
    groups.push({ keys: new Set([...keys, ...hit.flatMap((h) => [...h.keys])]), edits: [e, ...hit.flatMap((h) => h.edits)] });
  }
  const live = new Set(d.folders.map((f) => f.id));
  const folderOf = (id: string) => (d.items[id] && live.has(d.items[id]) ? d.items[id] : null);
  let changed = false;
  for (const g of groups) {
    if (g.edits.length < 2) continue;
    const byAge = [...g.edits].sort((a, b) => a.createdAt - b.createdAt);
    const loose = byAge.filter((e) => !folderOf(e.id) && !filed[e.id]);
    if (!loose.length) continue;
    let target = byAge.map((e) => folderOf(e.id)).filter(Boolean).at(-1) ?? null;
    if (!target) {
      if (loose.length < 2) continue;
      const ws = byAge[0]!.projectId;
      target = newId();
      d.folders.push({ id: target, name: videoName(byAge[0]!.name), parentId: null, createdAt: Date.now(), ...(ws ? { workspace: ws } : {}) });
      live.add(target);
    }
    for (const e of loose) {
      d.items[e.id] = target;
      filed[e.id] = target;
    }
    changed = true;
  }
  return changed;
}

// ---- the record of what was filed, one small file per person ----

interface Filed { filed: Record<string, string>; ran?: boolean }
const fileOf = (username: string) => path.join(env.dataDir, "editor", ".projects", `${username}.json`);
async function readFiled(username: string): Promise<Filed> {
  try {
    const v = JSON.parse(await readFile(fileOf(username), "utf-8")) as Partial<Filed>;
    return { filed: v.filed && typeof v.filed === "object" ? v.filed : {}, ran: v.ran === true };
  } catch {
    return { filed: {} };
  }
}
async function saveFiled(username: string, f: Filed) {
  const file = fileOf(username);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, JSON.stringify(f));
  await rename(tmp, file);
}

let chain: Promise<unknown> = Promise.resolve();
/**
 * Files `username`'s loose edits into their videos' folders. `once`: only if it never ran for them (the list's first read
 * after this shipped). Never throws: the list and a new edit work without it.
 */
export function fileIntoProjects(username: string, edits: () => Promise<Groupable[]> | Groupable[], once = false): Promise<void> {
  const next = chain.then(async () => {
    const rec = await readFiled(username);
    if (once && rec.ran) return;
    const all = await edits();
    const changed = await changeFolders("editor", username, (d) => groupEdits(all, d, rec.filed));
    await saveFiled(username, { filed: rec.filed, ran: true });
    if (changed === true) announce(username, "folders");
  });
  chain = next.catch(() => undefined);
  return next.catch((e) => console.error("[editor] filing edits into projects:", e));
}
