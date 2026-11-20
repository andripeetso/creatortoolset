import { randomUUID } from "node:crypto";
import { FILMED_MAX, FOLDER_STATES, REPORT_FILES_MAX, type FolderState, type RelayFolder, type ReportAnswer, type ReportFile, type ReportFolder } from "../../contracts/places";
import { EVERY_WORKSPACE, editorDirsOf, leftOutBy, notFootage, okFolderPath, THIS_COMPUTER, type StorageFolder } from "../../contracts/storage";
import os from "node:os";
import path from "node:path";
import { deviceOf, isThisMachine } from "../lib/devices";
import type { Device } from "../../contracts/providers";
import { LIBRARY_WORDS } from "../../contracts/library";
import type { SessionUser } from "../users";
import { storageOf, updateFolder } from "../devices-storage";
import { projectOf } from "../lib/project-of";
import { inside } from "../lib/storage";
import { ownedProjects, sharedProjects } from "../lib/workshop/workspace";
import { isTeamMember } from "../lib/workspaces";
import { accountOf, ensureLibrary, homeOf, librariesHere, libraryChanged, servedByPlugin } from "./access";
import { blursFaces, libraryDb } from "./db";
import { mergeSamePath } from "./place-rows";
import { enqueueJob } from "./jobs";
import { setTrashedAt, showHidden, trashHeld } from "./trash";
import { indexOnMac, patchFilmed, type Filmed, type OnMacIndex } from "./on-mac";
import { organizeOf } from "./organize";
import { reshoot } from "./shoots";

/**
 * The computers report, the server records (local first, P1). A location agent (the Mac app's LocationAgent, the Linux
 * helper) lists the folders the person pointed at the Media Library on that computer and posts each listing here
 * (contracts/places.ts ReportV2). The server never opens those paths: it matches the listed files to the versions of
 * the folder's libraries and writes that computer's place rows (version_places), and answers the files that match no
 * version, which the agent indexes where they are (POST /api/devices/relay/index). No file is uploaded.
 */

const db = () => libraryDb();
const nfc = (p: string) => p.normalize("NFC");

/** A media folder of a computer, as its agent sees it (GET /api/devices/relay/folders). */
export const useOf = (f: StorageFolder): RelayFolder["use"] => (f.role === "projects" ? "projects" : f.role === "library" || f.role === "finals" ? "exports" : "media");

/** This computer's Projects and Exports folders (its paths): never footage, wherever they sit, even inside a Media folder. */
export const keptOut = (st: { folders: StorageFolder[] }, host: string): string[] =>
  st.folders.filter((x) => x.origin.host === host && useOf(x) !== "media").map((x) => x.origin.path);

/** The workspace ids a folder is in, "*" for every one; a folder from before workspaces is the first brand's. */
async function workspacesOf(owner: string, f: StorageFolder): Promise<string[] | "*"> {
  if (f.workspace === EVERY_WORKSPACE) return "*";
  const of = await projectOf({ username: owner } as SessionUser);
  // an account with no workspaces: everything it has is one library, so the folder is in all of it
  if (!of) return "*";
  return [...new Set((f.workspaces ?? [f.workspace]).map((w) => (w ? w : of(undefined))))];
}

/** The folders computer `d` holds itself (it added them in Settings → Folders), with their workspaces. */
export async function relayFolders(d: Device): Promise<RelayFolder[]> {
  if (d.owner === "workspace") return [];
  const st = await storageOf(d.owner);
  const mine = st.folders.filter((f) => f.origin.host === d.id);
  return Promise.all(
    mine.map(async (f) => ({ id: f.id, path: f.origin.path, hostPath: f.origin.path, mountPath: f.mountPath ?? f.origin.path, workspaces: await workspacesOf(d.owner, f), use: useOf(f) })),
  );
}

/** A library a folder's files are matched in. `locate`: a workspace the owner was given by its team owner; the files are
 *  only found there (version_places on this computer), never indexed, never new versions. */
export type FolderLibrary = { id: string; locate: boolean };

/** Whether a Media folder in workspace `id` (of `owner`) fills no core library: a plug-in serves that workspace's media
 *  itself (servedByPlugin), so its rows index and locate nothing there. P2 (the Blur faces gate) replaces this condition. */
const keptFromLibrary = (owner: string, id?: string): Promise<boolean> => servedByPlugin(owner, id);

/** The libraries a folder fills: one per workspace it is in (made when missing), every workspace's for "*". A member
 *  never gets a library of a workspace they were given: the owner's one is used, locate only. A workspace a plug-in
 *  serves itself gets none (keptFromLibrary). */
export async function librariesOf(owner: string, f: StorageFolder, make = true): Promise<FolderLibrary[]> {
  const ws = await workspacesOf(owner, f);
  const owned = await ownedProjects(owner);
  const ids = ws === "*" ? owned.map((p) => p.id) : ws;
  const given = new Map((await sharedProjects(owner)).map((p) => [p.id, p.owner]));
  const member = isTeamMember(owner);
  // make=false (a read, a GET): the libraries that exist, none made
  const libraryFor = (id?: string) => (make ? ensureLibrary(owner, id) : librariesHere(owner, id ?? "").then((l) => l[0]?.id ?? null));
  // an account with no workspaces: its one library. A member given workspaces but none of their own makes none (theirs are the owner's)
  if (!ids.length) {
    if ((member && given.size) || (await keptFromLibrary(owner))) return [];
    const one = await libraryFor();
    return one ? [{ id: one, locate: false }] : [];
  }
  const out: FolderLibrary[] = [];
  const add = (id: string, locate: boolean) => {
    if (!out.some((l) => l.id === id)) out.push({ id, locate });
  };
  for (const id of ids) {
    const from = given.get(id);
    // asked as the workspace's owner: a plug-in answers for its own brands
    if (await keptFromLibrary(from ?? owner, id)) continue;
    if (from) {
      const lib = (await librariesHere(from, id))[0]?.id;
      if (lib) add(lib, true);
    } else if (!member || owned.some((p) => p.id === id)) {
      const lib = await libraryFor(id);
      if (lib) add(lib, false);
    }
    // a member's workspace not given to them: no library made in their home
  }
  return out;
}

/** A report's folders, checked: known states, good paths, at most REPORT_FILES_MAX files in all. */
export function parseReportFolders(v: unknown): ReportFolder[] {
  if (!Array.isArray(v)) return [];
  let left = REPORT_FILES_MAX;
  const out: ReportFolder[] = [];
  for (const x of v.slice(0, 200)) {
    const o = (x ?? {}) as Record<string, unknown>;
    if (typeof o.id !== "string" || o.id.length > 80 || !FOLDER_STATES.includes(o.state as FolderState)) continue;
    const files: ReportFile[] = [];
    for (const f of Array.isArray(o.files) ? o.files : []) {
      if (left <= 0) break;
      const r = (f ?? {}) as Record<string, unknown>;
      if (!okFolderPath(r.path) || !Number.isSafeInteger(r.bytes) || (r.bytes as number) < 0 || !Number.isFinite(r.mtime)) continue;
      const hex = (h: unknown) => (typeof h === "string" && /^[0-9a-f]{64}$/.test(h) ? h : undefined);
      const quick = hex(r.quick);
      const sha256 = hex(r.sha256);
      files.push({ path: nfc(r.path), bytes: r.bytes as number, mtime: Math.round(r.mtime as number), ...(quick ? { quick } : {}), ...(sha256 ? { sha256 } : {}) });
      left--;
    }
    out.push({
      id: o.id,
      state: o.state as FolderState,
      ...(typeof o.disk === "string" ? { disk: o.disk.slice(0, 200) } : {}),
      ...(typeof o.scan === "string" ? { scan: o.scan.slice(0, 80) } : {}),
      ...(o.complete === true ? { complete: true } : {}),
      ...(Number.isSafeInteger(o.page) && (o.page as number) >= 0 ? { page: o.page as number } : {}),
      files,
      unreadable: (Array.isArray(o.unreadable) ? o.unreadable : []).filter(okFolderPath).slice(0, 200).map(nfc),
    });
  }
  return out;
}

/** When each running listing started on this server, by computer, folder and scan id (listing_starts, schema.ts: kept
 *  through a restart): its last page marks the rows it did not name gone only when its first page was seen here. */
/** This server process: a listing of a computer that numbers no pages, begun before a restart, marks nothing gone. */
let bootId = randomUUID();
const scanStart = {
  /** a page came: the listing's start (its first page here) and, when numbered, which pages came */
  begin: (key: string, now: number, page?: number) => {
    db().prepare("INSERT OR IGNORE INTO listing_starts (key, at, boot) VALUES (?, ?, ?)").run(key, now, bootId);
    if (page !== undefined) db().prepare("UPDATE listing_starts SET pages = json_insert(pages, '$[#]', ?) WHERE key = ?").run(page, key);
  },
  of: (key: string) => (db().prepare("SELECT at FROM listing_starts WHERE key = ?").get(key) as { at: number } | undefined)?.at,
  /** the listing began in this server process (a restart in between lost what came, for a computer that numbers no pages) */
  thisBoot: (key: string) => (db().prepare("SELECT boot FROM listing_starts WHERE key = ?").get(key) as { boot: string | null } | undefined)?.boot === bootId,
  /** every page from 0 to `last` came */
  whole: (key: string, last: number) => {
    const got = new Set(JSON.parse((db().prepare("SELECT pages FROM listing_starts WHERE key = ?").get(key) as { pages: string } | undefined)?.pages ?? "[]") as number[]);
    return Array.from({ length: last + 1 }, (_, i) => i).every((i) => got.has(i));
  },
  // done, and any listing never finished a week on
  end: (key: string, now: number) => db().prepare("DELETE FROM listing_starts WHERE key = ? OR at < ?").run(key, now - 7 * 86_400_000),
};
/** The AI Editor folders each listing (its key in listing_starts) has named so far, over all its pages; dropped when it completes. */
const editorSeen = new Map<string, Set<string>>();

/** The listing's AI Editor folders with this page's: `fresh` are the ones this page names first. */
export function editorDirsSeen(key: string, scan: string | undefined, rels: string[]): { dirs: Set<string>; fresh: string[] } {
  const dirs = scan ? (editorSeen.get(key) ?? new Set<string>()) : new Set<string>();
  const here = editorDirsOf(rels);
  const fresh = [...here].filter((x) => !dirs.has(x));
  for (const x of here) dirs.add(x);
  if (scan) editorSeen.set(key, dirs);
  return { dirs, fresh };
}

/**
 * A place (version_places p) that is one of the library's own copies (copies.ts, Media Library Copies), at the path its
 * copy was written to: never a copy of a clip's own that keeps it in the library, and never a left-out file.
 */
const COPY_PLACE = `EXISTS (SELECT 1 FROM copy_files cf JOIN library_copies c ON c.id = cf.copy_id
  WHERE cf.version_id = p.version_id AND c.device = p.device AND p.path = rtrim(c.path, '/') || '/' || cf.rel_path)`;

/** Every file the library's copies wrote on `devices` (copies.ts), by its full path: read once per report or watch pass. */
export function copyFilesOn(devices: string[]): Set<string> {
  if (!devices.length) return new Set();
  const rows = db()
    .prepare("SELECT rtrim(c.path, '/') || '/' || cf.rel_path AS at FROM copy_files cf JOIN library_copies c ON c.id = cf.copy_id WHERE c.device IN (SELECT value FROM json_each(?)) AND cf.rel_path IS NOT NULL")
    .all(JSON.stringify(devices)) as { at: string }[];
  return new Set(rows.map((r) => r.at));
}

/**
 * The files `where` (a condition on version_places p) matches are not footage: their place rows of this folder turn gone
 * (a member's locate-only one too), and each clip of the libraries in `own` made from one is a candidate to leave the
 * library. `pending` collects them until the listing is read whole (settleLeft): a copy of the same file elsewhere in it,
 * on a later page, keeps the clip.
 */
function leaveLibrary(dev: Device, folderId: string, inLibs: string, own: ReadonlySet<string>, now: number, where: string, args: string[], pending: Set<string>, uploaded = false): void {
  const rows = db()
    .prepare(
      // a place with no folder (the Mac window's index, a Locate) is this folder's file too
      // `uploaded`: a left-out file's clip leaves even when the server keeps its bytes; otherwise only one read where it is
      `SELECT p.rowid AS place, a.id, a.library_id FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
       WHERE p.device = ? AND p.folder_id IN (?, '') AND p.kind = 'original' AND ${where} ${uploaded ? "" : "AND v.source_key LIKE 'mac:%'"} AND a.trashed_at IS NULL
         AND a.library_id IN (SELECT value FROM json_each(?)) AND NOT ${COPY_PLACE}`,
    )
    .all(dev.id, folderId, ...args, inLibs) as { place: number; id: string; library_id: string }[];
  const gone = db().prepare("UPDATE version_places SET state = 'gone', gone_at = ? WHERE rowid = ?");
  for (const r of rows) {
    gone.run(now, r.place);
    if (own.has(r.library_id)) pending.add(r.id);
  }
}

/**
 * A clip's places that count as a copy of it, in `states`: not one of the library's own copies (COPY_PLACE), and not
 * inside a folder a list leaves out (`media`, at the path the place's own computer has: a file this server's watch
 * marks found again there is no copy outside them). Prepared once per call of its caller.
 */
const placesThatCount = (states: string[]) => {
  const q = db().prepare(
    `SELECT p.path, p.device FROM version_places p JOIN asset_versions v ON v.id = p.version_id
      WHERE v.asset_id = ? AND p.kind = 'original' AND p.state IN (SELECT value FROM json_each(?)) AND NOT ${COPY_PLACE}`,
  );
  const want = JSON.stringify(states);
  // each computer's own path of a folder counts (a folder of this server's own computer, "this-computer", is its device's)
  const out = (media: StorageFolder[], p: { path: string; device: string }) =>
    leftOutBy(media, p.path, p.device) || (isThisMachine(p.device) && leftOutBy(media, p.path, THIS_COMPUTER));
  return (id: string, media: StorageFolder[]) => (q.all(id, want) as { path: string; device: string }[]).some((p) => !out(media, p));
};

/** Whether a clip has a known copy (placesThatCount: verified or found, `media` the lists): this server's watch asks. */
export const knownCopy = () => placesThatCount(["verified", "found"]);

/**
 * Moves each clip of `assets` into the trash unless it is held (trash.ts trashHeld) or another copy of it is still found
 * somewhere (a verified or found place of any of its versions, on any computer, that counts: placesThatCount), or may be:
 * one on a drive not read now (unchecked) is unknown, never gone. `media`: the lists that leave a place out. Returns the
 * ones it moved.
 */
export function settleLeft(assets: Iterable<string>, now: number, what: string, media: StorageFolder[] = []): string[] {
  const live = placesThatCount(["verified", "found", "unchecked"]);
  const moved: string[] = [];
  for (const id of assets) {
    if (live(id, media)) {
      showHidden(id);
      continue;
    }
    const held = trashHeld(id, now);
    if (held) {
      // said once per clip: the watch asks again every pass
      if (!heldSaid.has(id)) console.log(`[library] ${what}: ${id} stays in the library (${held}), not moved to the trash`);
      heldSaid.add(id);
      showHidden(id);
      continue;
    }
    setTrashedAt(id, now);
    moved.push(id);
  }
  return moved;
}

const heldSaid = new Set<string>();

/** A clip kept: shown again where it was hidden while it waited (left_hidden_at, schema.ts). */

/**
 * The clips waiting on computer `device` (leftWaiting) after a report. Computers no longer paired drop theirs. A clip
 * hidden while it waited that no computer waits on now (a restart forgot it) waits again on the computer it was hidden
 * on (left_hidden_on) once that one reports, never on another that once had it (one whose computer went silent:
 * settleSilent). A clip the watch hid is the watch's.
 */
function adoptLeft(device: string, now: number): void {
  for (const id of leftWaiting.keys()) if (!deviceOf(id)) leftWaiting.delete(id);
  const waitingAnywhere = (a: string) => [...leftWaiting.values()].some((w) => w.has(a));
  const hidden = db()
    .prepare("SELECT id, left_hidden_on AS root FROM assets WHERE left_hidden_at IS NOT NULL AND trashed_at IS NULL AND left_hidden_on IS NOT NULL")
    .all() as { id: string; root: string }[];
  const waiting = leftWaiting.get(device) ?? new Map<string, number>();
  for (const h of hidden) {
    if (waitingAnywhere(h.id)) continue;
    if (h.root === device) waiting.set(h.id, now);
  }
  if (waiting.size) leftWaiting.set(device, waiting);
}

// a computer silent this long is treated as gone, so a clip hidden while it waited on it never stays hidden for good:
// it goes to the trash, which Restore undoes (owner, 2026-11-20)
export const SILENT_MS = 14 * 86_400_000;

/**
 * Clips hidden while they waited on a computer that has sent no report for SILENT_MS (its last seen time; one no longer
 * paired from when it was first missed here, left_gone_computers): settled as gone, into the trash (never deleted; the
 * Library status names the computer, left_trashed_from), unless a copy of it is known elsewhere (placesThatCount, `media`
 * its own library's lists) or it is held in Review or by a share link: shown again. Run from every report and every watch pass.
 * Returns the libraries changed.
 */
export async function settleSilent(now: number): Promise<string[]> {
  const d = db();
  const known = placesThatCount(["verified", "found"]);
  const hidden = d
    .prepare("SELECT id, library_id, left_hidden_on AS device FROM assets WHERE left_hidden_at IS NOT NULL AND trashed_at IS NULL AND left_hidden_on IS NOT NULL")
    .all() as { id: string; library_id: string; device: string }[];
  // each computer once: when it went silent (one no longer paired: from when it was first missed)
  const silentSince = new Map<string, { since: number; name: string }>();
  for (const device of new Set(hidden.map((h) => h.device))) {
    const dev = deviceOf(device);
    if (!dev) d.prepare("INSERT OR IGNORE INTO left_gone_computers (device, since) VALUES (?, ?)").run(device, now);
    else d.prepare("DELETE FROM left_gone_computers WHERE device = ?").run(device);
    const since = dev ? (dev.lastSeen ?? dev.createdAt) : (d.prepare("SELECT since FROM left_gone_computers WHERE device = ?").get(device) as { since: number }).since;
    silentSince.set(device, { since, name: dev?.name ?? "a computer no longer paired" });
  }
  // each clip judged by its own library's lists (its owner's Media folders), read once per library
  const lists = new Map<string, StorageFolder[]>();
  const listsOf = async (lib: string) => {
    if (!lists.has(lib)) lists.set(lib, await libraryLists(lib));
    return lists.get(lib)!;
  };
  const changed: string[] = [];
  for (const h of hidden) {
    const { since, name } = silentSince.get(h.device)!;
    if (now - since < SILENT_MS) continue;
    for (const w of leftWaiting.values()) w.delete(h.id);
    // a copy known elsewhere (another computer, an upload found again): shown, never trashed
    if (known(h.id, await listsOf(h.library_id)) || trashHeld(h.id, now)) showHidden(h.id);
    // still hidden after the lists were read: one shown or restored meanwhile is never trashed by this pass
    else if (d.prepare("SELECT 1 FROM assets WHERE id = ? AND left_hidden_at IS NOT NULL AND trashed_at IS NULL").get(h.id)) {
      setTrashedAt(h.id, now);
      d.prepare("UPDATE assets SET left_trashed_from = ? WHERE id = ?").run(name, h.id);
    }
    changed.push(h.library_id);
  }
  return changed;
}

/**
 * Folders left out are a privacy list (owner, 2026-11-20): a clip waiting on computer `device` whose only known place is
 * in a left-out folder is hidden at once (left_hidden_at), and shown again once a known place turns up: a verified or
 * found place that counts (placesThatCount: not a drive away, not one of the library's copies, not inside a folder
 * `media` leaves out). Hidden is not the trash: it is trashed or kept when it settles. Returns the libraries changed.
 */
function hideLeft(device: string, owner: string, now: number, media: StorageFolder[]): string[] {
  const d = db();
  const known = placesThatCount(["verified", "found"]);
  // a clip this server's watch hid first (no computer) waits on this one now: its computer is set too
  const hide = d.prepare(
    "UPDATE assets SET left_hidden_at = COALESCE(left_hidden_at, ?), left_hidden_on = COALESCE(left_hidden_on, ?) WHERE id = ? AND trashed_at IS NULL AND (left_hidden_at IS NULL OR left_hidden_on IS NULL)",
  );
  const show = d.prepare("UPDATE assets SET left_hidden_at = NULL, left_hidden_on = NULL WHERE id = ? AND left_hidden_at IS NOT NULL");
  const libOf = d.prepare("SELECT library_id FROM assets WHERE id = ?");
  const changed: string[] = [];
  const note = (id: string, r: { changes: number | bigint }) => {
    if (Number(r.changes)) changed.push((libOf.get(id) as { library_id: string }).library_id);
  };
  const waiting = leftWaiting.get(device);
  for (const id of waiting?.keys() ?? []) note(id, known(id, media) ? show.run(id) : hide.run(now, device, id));
  // every other clip hidden in this computer's owner's libraries (on another computer, by the watch): a copy known now,
  // verified anywhere, shows it at once. Only the owner's: `media` is the owner's lists, never another account's
  const theirs = d.prepare(
    "SELECT a.id FROM assets a JOIN libraries l ON l.id = a.library_id WHERE a.left_hidden_at IS NOT NULL AND a.trashed_at IS NULL AND l.workspace_id = ?",
  );
  for (const { id } of theirs.all(homeOf(owner)) as { id: string }[])
    if (!waiting?.has(id) && known(id, media)) note(id, show.run(id));
  return changed;
}

/**
 * Clips matched by size and fingerprint to a file in a left-out folder while they had a place elsewhere on the computer:
 * moved in there, or a copy, while their own file may have moved into another Media folder read later. Each waits, by
 * computer, from when it was first found, until every Media folder of that computer has finished a listing that started
 * then or later (`listed`); a folder not read (its drive away) never finishes, so nothing leaves on what is unknown. A
 * restart forgets them; the next listing of the left-out file finds them again.
 */
const leftWaiting = new Map<string, Map<string, number>>();
/** Clips `ids` wait on computer `device` from `now`; one already waiting keeps when it was first found. */
function waitOn(device: string, ids: Iterable<string>, now: number): void {
  const waiting = leftWaiting.get(device) ?? new Map<string, number>();
  for (const id of ids) if (!waiting.has(id)) waiting.set(id, now);
  if (waiting.size) leftWaiting.set(device, waiting);
}
/** A server restart, for tests: every listing in progress and every clip waiting is forgotten. */
export function forgetOnRestart(): void {
  for (const m of [leftWaiting, listed, leftSeen, editorSeen]) m.clear();
  bootId = randomUUID();
}
/** When the last finished listing of each folder started, by `${device}|${folder id}`. */
const listed = new Map<string, number>();

/**
 * The clips with a file's fingerprint and size (`?` quick, bytes) and a place on computer `?` other than path `?`, in
 * the libraries `?` (JSON): led by the fingerprint index (versions_quick, CROSS JOIN keeps that order), so a left-out
 * file never reads every place of its computer. An uploaded clip's place gone is no move (the server keeps its bytes).
 */
export const MOVED_IN = `SELECT DISTINCT a.id FROM asset_versions v CROSS JOIN version_places p ON p.version_id = v.id JOIN assets a ON a.id = v.asset_id
  WHERE v.quick = ? AND v.bytes = ? AND p.device = ? AND p.kind = 'original' AND p.path <> ? AND a.trashed_at IS NULL
    AND (v.source_key LIKE 'mac:%' OR p.state <> 'gone')
    AND a.library_id IN (SELECT value FROM json_each(?)) AND NOT ${COPY_PLACE}`;

/** The clips a listing (its key in listing_starts) found only in files that are not footage so far: settled when it completes.
 *  Only a listing that found one has an entry, and a new listing of the same folder drops the older ones. */
const leftSeen = new Map<string, Set<string>>();

type Hit = { version_id: string; library_id: string; vbytes: number; vquick: string | null; state: string; bytes: number | null; mtime: number | null; folder_id: string; unread: number };

function upsert(versionId: string, device: string, folder: string, f: ReportFile, state: string, source: string, now: number): void {
  const d = db();
  // a row from before for this computer (no folder) is this one now
  d.prepare("DELETE FROM version_places WHERE version_id = ? AND device = ? AND kind = 'original' AND folder_id = '' AND ? <> ''").run(versionId, device, folder);
  d.prepare(
    `INSERT INTO version_places (version_id, device, kind, folder_id, path, bytes, mtime, quick, sha256, state, source, confirmed_at, checked_at, verified_at, gone_at)
     VALUES (?, ?, 'original', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (version_id, device, kind, folder_id) DO UPDATE SET path = excluded.path, bytes = excluded.bytes, mtime = excluded.mtime,
       quick = COALESCE(excluded.quick, quick), sha256 = COALESCE(excluded.sha256, sha256), state = excluded.state,
       confirmed_at = COALESCE(excluded.confirmed_at, confirmed_at), checked_at = excluded.checked_at,
       verified_at = COALESCE(excluded.verified_at, verified_at), gone_at = excluded.gone_at`,
  ).run(
    versionId, device, folder, f.path, f.bytes, f.mtime, f.quick ?? null, f.sha256 ?? null, state, source,
    state === "gone" ? null : now, now, state === "verified" && f.quick ? now : null, state === "gone" ? now : null,
  );
  // the same file's row under a folder merged away: one row, this folder's
  mergeSamePath(versionId, device);
}

/** One folder's page of a listing from computer `device`: place rows written, the files no version matched answered. */
async function applyFolder(dev: Device, folder: StorageFolder, libraries: FolderLibrary[], r: ReportFolder, now: number, index: ReportAnswer["index"], touched: Set<string>, keepOut: string[], filmed: ReportAnswer["filmed"], media: StorageFolder[], settle: Set<string>, copies: () => Set<string>): Promise<void> {
  const d = db();
  const device = dev.id;
  const libs = libraries.map((l) => l.id);
  const locate = new Set(libraries.filter((l) => l.locate).map((l) => l.id));
  const inLibs = JSON.stringify(libs);
  // a locate-only library is matched, never trashed into
  const inOwn = JSON.stringify(libs.filter((l) => !locate.has(l)));
  const own = new Set(libs.filter((l) => !locate.has(l)));
  const state: FolderState = r.state;
  if (state !== "ok") {
    // not readable now: what was here is not checked, never gone
    d.prepare("UPDATE version_places SET state = 'unchecked', checked_at = ? WHERE device = ? AND folder_id = ? AND state IN ('verified','found')").run(now, device, folder.id);
    libs.forEach((l) => touched.add(l));
  } else {
    const key = `${device}|${folder.id}|${r.scan ?? ""}`;
    if (r.scan) scanStart.begin(key, now, r.page);
    // only files inside the folder (its own path on this computer, or inside its container)
    const placed = (r.files ?? []).flatMap((f) => {
      const rel = inside(f.path, folder.origin.path) ?? (folder.mountPath ? inside(f.path, folder.mountPath) : null);
      return rel === null ? [] : [{ f, rel }];
    });
    const { dirs: editorDirs, fresh } = editorDirsSeen(key, r.scan, placed.map((x) => x.rel));
    if (r.scan && !leftSeen.has(key)) for (const k of leftSeen.keys()) if (k.startsWith(`${device}|${folder.id}|`)) leftSeen.delete(k);
    const left = (r.scan && leftSeen.get(key)) || new Set<string>();
    // an AI Editor folder this page names that earlier pages of the listing indexed as footage: its clips leave now
    for (const dir of fresh) {
      const hit = placed.find((x) => x.rel.startsWith(`${dir}/`))!;
      const full = hit.f.path.slice(0, hit.f.path.length - hit.rel.length) + dir;
      leaveLibrary(dev, folder.id, inLibs, own, now, "(p.path = ? OR substr(p.path, 1, length(?) + 1) = ? || '/')", [full, full, full], left);
    }
    for (const { f, rel } of placed) {
      // not footage: an AI Editor folder, a folder this one leaves out, a half-written file, or anything inside a Projects or Exports folder
      // a file one of the library's copies wrote is never left out, whatever folder it went into
      const out = leftOutBy(media, f.path, device) && !copies().has(f.path);
      if (out || notFootage(rel, editorDirs) || keepOut.some((k) => inside(f.path, k) !== null)) {
        // indexed here before this rule: the clip leaves the library through the trash once the listing is read whole, unless
        // a copy of it is found elsewhere (never while in Review or shared); the file on the computer stays
        // a locate-only library is never trashed into
        // a file a list leaves out: its clip waits for every Media folder of the computer (leftWaiting), hidden meanwhile,
        // since a copy may be in a folder read later (one report a folder); any other file that is not footage settles
        // when this listing ends, as before
        if (!out) {
          leaveLibrary(dev, folder.id, inLibs, own, now, "p.path = ?", [f.path], left);
          continue;
        }
        const direct = new Set<string>();
        leaveLibrary(dev, folder.id, inLibs, own, now, "p.path = ?", [f.path], direct, true);
        waitOn(device, direct, now);
        // moved into a left-out folder: the clip at this file's size and fingerprint with a place elsewhere on this computer
        // (in any of its Media folders), where its file may have gone. An uploaded clip's file gone from where it was is no
        // move: the server keeps its bytes, wherever its computer copy went
        if (f.quick) waitOn(device, (d.prepare(MOVED_IN).all(f.quick, f.bytes, device, f.path, inOwn) as { id: string }[]).map((m) => m.id), now);
        continue;
      }
      const hits = d
        .prepare(
          `SELECT p.version_id, a.library_id, v.bytes AS vbytes, v.quick AS vquick, p.state, p.bytes, p.mtime, p.folder_id, json_type(v.probe, '$.camera') IS NULL AS unread
           FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
           WHERE p.device = ? AND p.kind = 'original' AND p.folder_id IN (?, '') AND p.path = ?
             AND a.library_id IN (SELECT value FROM json_each(?))`,
        )
        .all(device, folder.id, f.path, inLibs) as Hit[];
      // a trashed clip's file counts too: its place is kept and it stays in the trash, never indexed again as new
      const done = new Set<string>();
      for (const h of hits) {
        const same = f.bytes === h.vbytes && (!f.quick || !h.vquick || f.quick === h.vquick);
        const next = !same ? "gone" : f.quick && h.vquick ? "verified" : h.state === "verified" && h.bytes === f.bytes && h.mtime === f.mtime ? "verified" : "found";
        upsert(h.version_id, device, folder.id, next === "verified" && !f.quick ? { ...f, quick: h.vquick ?? undefined } : f, next, "scan", now);
        if (next !== "gone") done.add(h.library_id);
        // never read for when it was filmed (indexed by a Mac app before 11-19): this computer reads it once
        if (filmed && next !== "gone" && h.unread && filmed.length < FILMED_MAX && !filmed.some((x) => x.folder === folder.id && x.path === f.path)) filmed.push({ folder: folder.id, path: f.path });
        touched.add(h.library_id);
      }
      for (const lib of libs.filter((l) => !done.has(l))) {
        // a member's locate-only library: a file it does not have is not for indexing (indexForDevice skips it too)
        // the same file indexed before (an upload, another computer's copy): its fingerprint and size
        let found = f.quick
          ? (d.prepare("SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND v.bytes = ? AND v.quick = ?").all(lib, f.bytes, f.quick) as { id: string }[]).map((x) => ({ id: x.id, state: "verified" }))
          : [];
        if (!found.length && !f.quick) {
          // renamed or moved inside the folder: one row of this folder not seen at its path, same size and time
          const was = d
            .prepare(
              `SELECT p.version_id AS id FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
               WHERE p.device = ? AND p.folder_id = ? AND p.kind = 'original' AND p.state IN ('gone','unchecked') AND p.bytes = ? AND p.mtime = ? AND a.library_id = ? AND p.path <> ?`,
            )
            .all(device, folder.id, f.bytes, f.mtime, lib, f.path) as { id: string }[];
          if (was.length === 1) {
            found = [{ id: was[0]!.id, state: "found" }];
            console.log(`[library] ${dev.name}: ${was[0]!.id} relinked at ${f.path} (same size and time)`);
          }
        }
        for (const x of found) upsert(x.id, device, folder.id, f, x.state, "scan", now);
        if (found.length) touched.add(lib);
        else if (!locate.has(lib) && !index.some((i) => i.folder === folder.id && i.path === f.path)) index.push({ folder: folder.id, path: f.path, ...(libs.some(blursFaces) ? { blur: true as const } : {}) });
      }
    }
    for (const dir of r.unreadable ?? []) {
      d.prepare("UPDATE version_places SET state = CASE WHEN state = 'gone' THEN 'gone' ELSE 'unchecked' END, checked_at = ? WHERE device = ? AND folder_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
        .run(now, device, folder.id, dir, dir, dir);
    }
    const start = r.scan ? scanStart.of(key) : undefined;
    // whole: a report of no listing, or a numbered listing all of whose pages came. A listing with a page lost marks
    // nothing gone (what was on that page was not looked at); one from a computer that numbers no pages marks as before
    const whole = !r.scan || (r.complete === true && start !== undefined && r.page !== undefined && scanStart.whole(key, r.page));
    if (r.complete) editorSeen.delete(key);
    // a computer that numbers no pages: as before, a listing it began in this server process marks what it did not name gone
    if (r.complete && start !== undefined && (r.page === undefined ? scanStart.thisBoot(key) : whole)) {
      const gone = d
        // only in the libraries the folder fills now: a row of a library it no longer fills was not looked for, not gone
        .prepare(
          `UPDATE version_places SET state = 'gone', gone_at = ? WHERE device = ? AND folder_id = ? AND kind = 'original' AND state <> 'gone'
             AND (checked_at IS NULL OR checked_at < ?)
             AND version_id IN (SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id IN (SELECT value FROM json_each(?)))`,
        )
        .run(now, device, folder.id, start, inLibs);
      if (Number(gone.changes)) libs.forEach((l) => touched.add(l));
    }
    if (r.complete && start !== undefined) scanStart.end(key, now);
    // a page of no listing, or the last page of one: its clips found only where they are not footage leave once the whole
    // report is read (applyReport), so a copy in a later folder of it keeps the clip; one waiting for the computer's
    // folders (moved in) leaves only from there
    if (!r.scan || r.complete) {
      const waiting = leftWaiting.get(device);
      for (const a of left) if (!waiting?.has(a)) settle.add(a);
      leftSeen.delete(key);
      // only a whole listing reads the folder for Folders left out: one with a page lost, or from a computer that
      // numbers no pages, never settles a clip waiting on it
      if (whole) listed.set(`${device}|${folder.id}`, start ?? now);
    } else if (left.size) leftSeen.set(key, left);
  }
  const was = folder.folderState;
  if (was !== state || !folder.checkedAt || now - folder.checkedAt > 5 * 60_000)
    await updateFolder(dev.owner, folder.id, (f) => ({ ...f, folderState: state, checkedAt: now }));
}

/** A report's folders from computer `dev`: the folders it holds, matched; the files that match nothing answered. */
export async function applyReport(dev: Device, folders: ReportFolder[], now = Date.now(), reads = false): Promise<ReportAnswer> {
  const index: ReportAnswer["index"] = [];
  // only a computer that says it reads when files were filmed is asked (contracts/places.ts ReportV2.filmed)
  const filmed: ReportAnswer["filmed"] = reads ? [] : undefined;
  // a report with no folders still settles what waits on this computer (one with no Media folders any more)
  if (dev.owner === "workspace") return { ok: true, index };
  const st = await storageOf(dev.owner);
  const touched = new Set<string>();
  const keepOut = keptOut(st, dev.id);
  const settle = new Set<string>();
  // a clip that begins to wait in this report is hidden at once, not at its listing's last page
  const waitingBefore = new Set(leftWaiting.get(dev.id)?.keys() ?? []);
  const media = mediaOf(st);
  // the copies' files, read the first time a list leaves a file out
  let read: Set<string> | undefined;
  const copies = () => (read ??= copyFilesOn([dev.id]));
  for (const r of folders) {
    const folder = st.folders.find((f) => f.id === r.id && f.origin.host === dev.id);
    if (!folder || useOf(folder) !== "media") continue;
    const of = await librariesOf(dev.owner, folder);
    await applyFolder(dev, folder, of, r, now, index, touched, keepOut, filmed, media, settle, copies);
  }
  const waitAdded = [...(leftWaiting.get(dev.id)?.keys() ?? [])].some((a) => !waitingBefore.has(a));
  // the clips waiting on this computer's other folders: settled once every one of its Media folders has listed since
  const waiting = leftWaiting.get(dev.id);
  if (waiting) {
    const here = st.folders.filter((f) => f.origin.host === dev.id && useOf(f) === "media");
    for (const [a, at] of waiting) {
      if (!here.every((f) => (listed.get(`${dev.id}|${f.id}`) ?? -1) >= at)) continue;
      settle.add(a);
      waiting.delete(a);
    }
    if (!waiting.size) leftWaiting.delete(dev.id);
  }
  adoptLeft(dev.id, now);
  for (const id of settleLeft(settle, now, dev.name, media)) {
    const lib = db().prepare("SELECT library_id FROM assets WHERE id = ?").get(id) as { library_id: string } | undefined;
    if (lib) touched.add(lib.library_id);
  }
  // only a report that can change what is known: a last page, a page of no listing, a folder not read, or a clip settled
  const changes = settle.size > 0 || waitAdded || folders.some((r) => !r.scan || r.complete || r.state !== "ok");
  if (changes) for (const l of hideLeft(dev.id, dev.owner, now, media)) touched.add(l);
  for (const l of await settleSilent(now)) touched.add(l);
  for (const l of touched) libraryChanged(l);
  return { ok: true, index, ...(filmed?.length ? { filmed } : {}) };
}

/**
 * POST /api/devices/relay/filmed: when, where and by what a known file of a folder of computer `dev` was filmed, read
 * on that computer (the report's `filmed` answer). Every version at that path and size gets what its probe lacks
 * (on-mac.ts patchFilmed); one whose date or place is new leaves the shoot the app filed it in for its own (shoots.ts
 * reshoot). Returns how many versions it read for.
 */
export async function filmedForDevice(dev: Device, folderId: string, x: { path: string; size: number } & Filmed): Promise<number | string> {
  if (dev.owner === "workspace") return "Not for this computer";
  const st = await storageOf(dev.owner);
  if (!st.folders.some((f) => f.id === folderId && f.origin.host === dev.id)) return "Not one of this computer's folders";
  const d = db();
  const rows = d
    .prepare(
      `SELECT v.id AS version, a.id, a.library_id, a.kind, a.created_by FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
       WHERE p.device = ? AND p.folder_id = ? AND p.kind = 'original' AND p.path = ? AND v.bytes = ? AND a.current_version_id = v.id`,
    )
    .all(dev.id, folderId, nfc(x.path), x.size) as { version: string; id: string; library_id: string; kind: string; created_by: string }[];
  for (const r of rows) {
    if ((await patchFilmed(d, r.version, x)) && organizeOf(r.library_id, d) === "ai") reshoot(d, r);
    libraryChanged(r.library_id);
  }
  return rows.length;
}

/**
 * An account's Media folders, whose leave-out lists every reader applies (contracts/storage.ts leftOutBy). One on this
 * server's own computer has its "~/" read as this computer's home, as its watch reads it.
 */
export const mediaOf = (st: { folders: StorageFolder[] }): StorageFolder[] =>
  st.folders
    .filter((f) => useOf(f) === "media")
    .map((f) => ((f.origin.host === THIS_COMPUTER || isThisMachine(f.origin.host)) && (f.origin.path === "~" || f.origin.path.startsWith("~/")) ? { ...f, origin: { ...f.origin, path: path.join(os.homedir(), f.origin.path.slice(1)) } } : f));

export const mediaFoldersOf = async (user: string): Promise<StorageFolder[]> => mediaOf(await storageOf(user));

/** The lists a clip of `libraryId` is judged by: its owner's Media folders (settleSilent). */
async function libraryLists(libraryId: string): Promise<StorageFolder[]> {
  const row = db().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as { workspace_id: string } | undefined;
  const owner = row ? accountOf(row.workspace_id) : null;
  return owner ? mediaFoldersOf(owner) : [];
}

/**
 * The Media folders whose lists a file `user` brings into `libraryId` is checked against: the person's own and, for a
 * member adding to the owner's library, the owner's too. Either list leaves a file out: they are privacy lists.
 */
export async function mediaForLibrary(user: string, libraryId: string): Promise<StorageFolder[]> {
  const row = db().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as { workspace_id: string } | undefined;
  const owner = row ? accountOf(row.workspace_id) : null;
  return [...(await mediaFoldersOf(user)), ...(owner && owner !== user ? await mediaFoldersOf(owner) : [])];
}

/**
 * The check every file `user` brings into `libraryId` gets (contracts/storage.ts leftOutBy over mediaForLibrary): true
 * when a list leaves it out. `device`: the computer the file is on; it counts only when it is one of `user`'s, otherwise
 * every computer's path counts. Read once, for a whole batch.
 */
export async function leftOutFor(user: string, libraryId: string, device?: string | null): Promise<(file: string) => boolean> {
  const media = await mediaForLibrary(user, libraryId);
  const host = device && deviceOf(device)?.owner === user ? device : undefined;
  return (file) => leftOutBy(media, file, host);
}

/**
 * POST /api/devices/relay/index: one file of a folder of computer `dev`, indexed where it is in each library the folder
 * fills (on-mac.ts indexOnMac: what the computer made of it, never its bytes). The folder must be that computer's, and the
 * path inside it.
 */
export async function indexForDevice(dev: Device, folderId: string, x: OnMacIndex): Promise<{ versions: Array<{ library: string; versionId?: string; duplicateOf?: string }> } | string> {
  if (dev.owner === "workspace") return "Not for this computer";
  const st = await storageOf(dev.owner);
  const folder = st.folders.find((f) => f.id === folderId && f.origin.host === dev.id);
  if (!folder || useOf(folder) !== "media") return "Not one of this computer's folders";
  if (inside(nfc(x.path), folder.origin.path) === null && !(folder.mountPath && inside(nfc(x.path), folder.mountPath) !== null)) return "Not inside that folder";
  // a file of a Projects or Exports folder is never footage, even when a computer sends it (applyFolder keeps them out too)
  if (keptOut(st, dev.id).some((k) => inside(nfc(x.path), k) !== null)) return LIBRARY_WORDS.notFootage;
  const rel = inside(nfc(x.path), folder.origin.path) ?? (folder.mountPath ? inside(nfc(x.path), folder.mountPath) : null);
  if ((rel !== null && notFootage(rel)) || leftOutBy(mediaOf(st), nfc(x.path), dev.id)) return LIBRARY_WORDS.notFootage;
  const versions: Array<{ library: string; versionId?: string; duplicateOf?: string }> = [];
  for (const { id: library, locate } of await librariesOf(dev.owner, folder)) {
    // a member's workspace is only located, never indexed into (applyFolder answers no file for it)
    if (locate) continue;
    const r = await indexOnMac(library, dev.owner, { ...x, path: nfc(x.path), device: dev.id, folder: folder.id });
    versions.push({ library, ...("versionId" in r ? { versionId: r.versionId } : "duplicateOf" in r ? { duplicateOf: r.duplicateOf } : {}) });
  }
  return { versions };
}
