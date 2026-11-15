import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { FOLDER_LIST_KIND, type DeviceJob } from "../../contracts/devices";
import { needsLine } from "../../contracts/tools";
import { kindOf } from "../library/routes";
import { libraryDb } from "../library/db";
import { wholeDisk } from "../library/watch";
import { deviceOf, isOnline, listDevices } from "./devices";
import { wakeEditorPolls } from "./mac-claude";
import type { DeviceJobSlot } from "./plugin";

/**
 * What is inside a folder on the person's computer, its subfolders too, for the assistant's folder_list
 * (api/assistant.ts POST /folder-list). Walked here when the folder is on the computer this server runs on (the Mac
 * app's own server), else by a Mac of the person's own (FOLDER_LIST_KIND, the Mac app's FolderListJob.swift), which
 * walks the same way and sends what it saw; matching and the cap are applied here either way.
 * The walk goes level by level, never into hidden entries, links or app packages, and stops at FOLDER_LIST's limits.
 */

export const FOLDER_LIST = {
  /** levels below the folder */
  depth: 6,
  /** entries in one answer */
  entries: 2000,
  /** entries one walk looks at, and its time: what is past them is said to be left out */
  walk: 20_000,
  ms: 10_000,
  /** how long a Mac has to answer, under the AI's minute */
  waitMs: 45_000,
} as const;

/** One entry as walked: its path inside the folder ("/" between levels), a folder or a file's bytes. */
export type Walked = { path: string; dir?: true; size?: number };
/** A walk: what it saw, how many folders were past the depth or could not be read, and whether it stopped at its limits. */
export type FolderWalk = { entries: Walked[]; deeper: number; unreadable?: number; stopped?: true };

/** A folder that is a package on a Mac (an app, a Photos or Final Cut library): one entry, never walked into. */
const PACKAGE = /\.(app|bundle|framework|photoslibrary|fcpbundle|fcpxbundle|imovielibrary|lrlibrary|tvlibrary|musiclibrary|aplibrary|logicx|band|rtfd|pages|numbers|key)$/i;

/** Walks `root` (a real path) `depth` levels down, as the Mac app's FolderListJob does. Rejects when `root` can't be read. */
export async function walkFolder(root: string, depth: number = FOLDER_LIST.depth): Promise<FolderWalk> {
  const by = Date.now() + FOLDER_LIST.ms;
  const entries: Walked[] = [];
  let deeper = 0;
  let unreadable = 0;
  const done = (stopped: boolean): FolderWalk => ({ entries, deeper, ...(unreadable ? { unreadable } : {}), ...(stopped ? { stopped: true as const } : {}) });
  // a folder macOS keeps private (Desktop, Documents, a removable drive) is said to be unreadable, never shown empty
  await readdir(root).catch(() => {
    throw new Error(`${root} could not be read on this computer (no permission to read it).`);
  });
  let level = [""];
  for (let d = 1; level.length; d++) {
    const next: string[] = [];
    for (const rel of level) {
      if (entries.length >= FOLDER_LIST.walk || Date.now() > by) return done(true);
      const found = await readdir(path.join(root, rel), { withFileTypes: true }).catch(() => (unreadable++, []));
      for (const e of found.sort((a, b) => a.name.localeCompare(b.name))) {
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          entries.push({ path: p, dir: true });
          if (PACKAGE.test(e.name)) continue;
          if (d < depth) next.push(p);
          else deeper++;
        } else if (e.isFile()) {
          entries.push({ path: p, size: (await lstat(path.join(root, p)).catch(() => null))?.size ?? 0 });
        }
      }
    }
    level = next;
  }
  return done(false);
}

type Kind = "video" | "audio" | "image" | "doc";
/** Words that find a kind of file: "the song" finds audio wherever it is named. */
const KIND_WORDS: Record<Kind, string> = {
  video: "video videos clip clips footage film movie take takes",
  audio: "audio song songs music track tracks sound sounds recording voice",
  image: "image images photo photos picture pictures still stills",
  doc: "doc docs document documents script scripts text note notes",
};
const SKIP = new Set(["the", "a", "an", "my", "our", "of", "in", "on", "for", "and", "file", "files", "folder", "that", "this", "it"]);
/** The words of `match` an entry must all hold (in its path or its kind's words); empty matches everything. */
export const matchWords = (match: string): string[] => match.normalize("NFC").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w && !SKIP.has(w));

/** An entry as the AI reads it. */
export type FolderEntry = { path: string; type: "folder" | "file"; kind?: Kind; size?: number; duration_s?: number };
export type FolderListing = { folder: string; entries: FolderEntry[]; looked_at: number; matched?: number; left_out?: string; note?: string };

/** A walk as the AI reads it: matched, capped, with what was left out said in words. `durations`: seconds by entry path. */
export function listing(folder: string, walk: FolderWalk, match = "", durations: Record<string, number> = {}): FolderListing {
  const words = matchWords(match);
  const all = walk.entries.map((e): FolderEntry => {
    if (e.dir) return { path: e.path, type: "folder" };
    const kind = kindOf(e.path) as Kind;
    const d = durations[e.path];
    return { path: e.path, type: "file", kind, size: e.size ?? 0, ...(d ? { duration_s: Math.round(d * 10) / 10 } : {}) };
  });
  const hits = words.length ? all.filter((e) => words.every((w) => `${e.path.normalize("NFC").toLowerCase()} ${e.kind ? KIND_WORDS[e.kind] : "folder"}`.includes(w))) : all;
  const out = hits.slice(0, FOLDER_LIST.entries);
  const left = [
    hits.length > out.length ? `${hits.length - out.length} more entries past the first ${out.length} (a narrower folder or match shows them)` : "",
    walk.deeper ? `${walk.deeper} folders deeper than the depth asked, not looked in` : "",
    walk.unreadable ? `${walk.unreadable} folders that could not be read` : "",
    walk.stopped ? `the walk stopped after ${walk.entries.length} entries: the folder holds more than that` : "",
  ].filter(Boolean);
  return {
    folder,
    entries: out,
    looked_at: walk.entries.length,
    ...(words.length ? { matched: hits.length } : {}),
    ...(left.length ? { left_out: left.join("; ") } : {}),
    ...(words.length && !hits.length ? { note: `Nothing in its ${walk.entries.length} entries matches ${JSON.stringify(match)}: list it without match and read the names.` } : {}),
  };
}

/** The lengths the Media Library already knows for media files in `root` (their probe, kept when they came in). */
export function knownDurations(root: string, walk: FolderWalk): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    const q = libraryDb().prepare("SELECT probe FROM asset_versions WHERE source_path = ? AND probe IS NOT NULL ORDER BY created_at DESC LIMIT 1");
    for (const e of walk.entries) {
      if (e.dir || !/^(video|audio)$/.test(kindOf(e.path))) continue;
      const row = q.get(path.join(root, e.path)) as { probe: string } | undefined;
      const d = row ? Number((JSON.parse(row.probe) as { duration?: number }).duration) : 0;
      if (d > 0) out[e.path] = d;
    }
  } catch {
    // no library on this server yet: no lengths
  }
  return out;
}

/** A folder on this computer, checked: its real path, or why not. `drive`: a drive's own top folder is fine. */
export async function folderHere(given: string, drive: boolean): Promise<{ real: string } | { error: string }> {
  const real = await realpath(given).catch(() => null);
  if (!real || !(await stat(real)).isDirectory()) return { error: `No such folder on this computer: ${given}` };
  if (await wholeDisk(real, drive)) return { error: `${real} is a whole disk or home folder: name the folder the files are in.` };
  return { real };
}

/* ---- a Mac of the person's own walks it (FOLDER_LIST_KIND) ---- */

interface Ask {
  id: number;
  owner: string;
  /** the Mac it is for (a Storage folder's computer); none = any of the owner's that takes the kind */
  want?: string;
  options: Record<string, string>;
  device?: string;
  end: (r: FolderWalk | Error) => void;
}
const asks = new Map<number, Ask>();
let lastId = 0;

/** Why no Mac of `owner`'s can list a folder now (`want`: that one); null when one can. */
export function noMacFor(owner: string, want?: string): string | null {
  const mine = listDevices((d) => d.owner === owner && (!want || d.id === want));
  const on = mine.filter((d) => isOnline(d.id));
  if (on.some((d) => d.kinds?.includes(FOLDER_LIST_KIND))) return null;
  if (on.length) return needsLine([{ what: "The newest Creator Toolset Mac app", anyOf: [], form: "ai" }]);
  const last = want ? deviceOf(want) : mine.sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
  return last ? `${last.name} is unreachable: the Creator Toolset app on it is not running.` : needsLine([{ what: "A Mac with Creator Toolset on", anyOf: [], form: "ai" }]);
}

/** `folder` (absolute, on that Mac) walked `depth` levels by a Mac of `owner`'s own. Rejects with a sentence a person can read. */
export function walkOnMac(owner: string, folder: string, depth: number, drive: boolean, want?: string): Promise<FolderWalk> {
  const missing = noMacFor(owner, want);
  if (missing) return Promise.reject(new Error(missing));
  if ([...asks.values()].filter((a) => a.owner === owner).length >= 5) return Promise.reject(new Error("5 folders are being looked through already: wait for one of them."));
  return new Promise((resolve, reject) => {
    const id = ++lastId;
    const timer = setTimeout(() => end(new Error(`The Mac did not answer in ${FOLDER_LIST.waitMs / 1000} seconds (it may be busy with another job): try again in a moment.`)), FOLDER_LIST.waitMs);
    const end = (r: FolderWalk | Error) => {
      clearTimeout(timer);
      asks.delete(id);
      if (r instanceof Error) reject(r);
      else resolve(r);
    };
    asks.set(id, { id, owner, ...(want ? { want } : {}), options: { path: folder, depth: String(depth), disk: drive ? "1" : "" }, end });
    // a poll the Mac holds right now is told at once
    void wakeEditorPolls();
  });
}

const free = (a: Ask, d: { id: string; owner: string }) => a.owner === d.owner && !a.device && (!a.want || a.want === d.id);
const held = (device: string, id: number) => {
  const a = asks.get(id);
  return a?.device === device ? a : undefined;
};

/** What a Mac sent, as a walk, or null when it is not one. Entries past the walk's limit and unreadable ones are left out. */
export function readWalk(body: unknown): FolderWalk | null {
  const b = body as { entries?: unknown; deeper?: unknown; unreadable?: unknown; stopped?: unknown } | null;
  if (!b || !Array.isArray(b.entries)) return null;
  const entries: Walked[] = [];
  for (const e of b.entries.slice(0, FOLDER_LIST.walk) as (Record<string, unknown> | null)[]) {
    const p = typeof e?.path === "string" ? e.path : "";
    if (!p || p.length > 1000 || /[\0\n\r]/.test(p) || p.startsWith("/") || p.split("/").includes("..")) continue;
    entries.push(e!.dir === true ? { path: p, dir: true } : { path: p, size: Number.isSafeInteger(e!.size) && (e!.size as number) >= 0 ? (e!.size as number) : 0 });
  }
  const deeper = Number.isSafeInteger(b.deeper) && (b.deeper as number) >= 0 ? (b.deeper as number) : 0;
  const unreadable = Number.isSafeInteger(b.unreadable) && (b.unreadable as number) > 0 ? (b.unreadable as number) : 0;
  return { entries, deeper, ...(unreadable ? { unreadable } : {}), ...(b.stopped === true || b.entries.length > FOLDER_LIST.walk ? { stopped: true as const } : {}) };
}

/** The device job road's side of it (api/devices.ts lists it before the plug-ins' own). */
export const folderListJob: DeviceJobSlot = {
  kind: FOLDER_LIST_KIND,
  waits: (owner, device) => [...asks.values()].some((a) => free(a, { id: device, owner })),
  claim: (d): DeviceJob | null => {
    const a = [...asks.values()].find((x) => free(x, d));
    if (!a) return null;
    a.device = d.id;
    return { id: a.id, kind: FOLDER_LIST_KIND, editId: "", variant: "", options: a.options };
  },
  input: async () => null,
  answer: async (device, id, body) => {
    const a = held(device, id);
    if (!a) return { error: "Not found", status: 404 };
    const walk = readWalk(body);
    if (!walk) return { error: "Send the folder's entries.", status: 400 };
    a.end(walk);
    return { reply: {} };
  },
  file: async () => ({ error: "Send the folder's entries as JSON.", status: 400 }),
  fail: (device, id, why) => {
    const a = held(device, id);
    if (!a) return false;
    a.end(new Error(why));
    return true;
  },
};
