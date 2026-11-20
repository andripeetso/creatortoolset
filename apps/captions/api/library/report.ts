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
import { accountOf, ensureLibrary, librariesHere, libraryChanged, servedByPlugin } from "./access";
import { libraryDb } from "./db";
import { mergeSamePath } from "./place-rows";
import { enqueueJob } from "./jobs";
import { setTrashedAt, trashHeld } from "./trash";
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
      files,
      unreadable: (Array.isArray(o.unreadable) ? o.unreadable : []).filter(okFolderPath).slice(0, 200).map(nfc),
    });
  }
  return out;
}

/** When each running listing started on this server, by computer, folder and scan id: a listing's last page marks the
 *  rows it did not name gone only when its first page was seen here (a restart in between marks nothing). */
const scans = new Map<string, number>();
/** The AI Editor folders each listing (its key in `scans`) has named so far, over all its pages; dropped when it completes. */
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
 * Moves each clip of `assets` into the trash unless it is held (trash.ts trashHeld) or another copy of it is still found
 * somewhere (a verified or found place of any of its versions, on any computer, that is not one of the library's own
 * copies, COPY_PLACE), or may be: one on a drive not read now (unchecked) is unknown, never gone. Returns the ones it moved.
 */
export function settleLeft(assets: Iterable<string>, now: number, what: string): string[] {
  const live = db().prepare(
    `SELECT 1 FROM version_places p JOIN asset_versions v ON v.id = p.version_id
      WHERE v.asset_id = ? AND p.kind = 'original' AND p.state IN ('verified','found','unchecked') AND NOT ${COPY_PLACE} LIMIT 1`,
  );
  const moved: string[] = [];
  for (const id of assets) {
    if (live.get(id)) continue;
    const held = trashHeld(id, now);
    if (held) {
      // said once per clip: the watch asks again every pass
      if (!heldSaid.has(id)) console.log(`[library] ${what}: ${id} stays in the library (${held}), not moved to the trash`);
      heldSaid.add(id);
      continue;
    }
    setTrashedAt(id, now);
    moved.push(id);
  }
  return moved;
}

const heldSaid = new Set<string>();

/** The clips a listing (its key in `scans`) found only in files that are not footage so far: settled when it completes.
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
async function applyFolder(dev: Device, folder: StorageFolder, libraries: FolderLibrary[], r: ReportFolder, now: number, index: ReportAnswer["index"], touched: Set<string>, keepOut: string[], filmed: ReportAnswer["filmed"], media: StorageFolder[], settle: Set<string>, copies: Set<string>): Promise<void> {
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
    if (r.scan && !scans.has(key)) scans.set(key, now);
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
      const out = leftOutBy(media, f.path, device) && !copies.has(f.path);
      if (out || notFootage(rel, editorDirs) || keepOut.some((k) => inside(f.path, k) !== null)) {
        // indexed here before this rule: the clip leaves the library through the trash once the listing is read whole, unless
        // a copy of it is found elsewhere (never while in Review or shared); the file on the computer stays
        // a locate-only library is never trashed into
        leaveLibrary(dev, folder.id, inLibs, own, now, "p.path = ?", [f.path], left, out);
        // moved into a left-out folder: the clip at this file's size and fingerprint with a place on this computer (in any
        // of its Media folders) is a candidate too (its old place turns gone when the listing completes; a real second copy still keeps it)
        if (out && f.quick) {
          const moved = d
            .prepare(
              `SELECT DISTINCT a.id FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
               WHERE p.device = ? AND p.kind = 'original' AND v.bytes = ? AND v.quick = ? AND a.trashed_at IS NULL
                 AND a.library_id IN (SELECT value FROM json_each(?)) AND NOT ${COPY_PLACE}`,
            )
            .all(device, f.bytes, f.quick, inOwn) as { id: string }[];
          for (const m of moved) left.add(m.id);
        }
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
        else if (!locate.has(lib) && !index.some((i) => i.folder === folder.id && i.path === f.path)) index.push({ folder: folder.id, path: f.path });
      }
    }
    for (const dir of r.unreadable ?? []) {
      d.prepare("UPDATE version_places SET state = CASE WHEN state = 'gone' THEN 'gone' ELSE 'unchecked' END, checked_at = ? WHERE device = ? AND folder_id = ? AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')")
        .run(now, device, folder.id, dir, dir, dir);
    }
    // a page of no listing, or the last page of one: its clips found only where they are not footage leave once the whole
    // report is read (applyReport), so a copy in a later folder of it keeps the clip
    if (!r.scan || r.complete) {
      left.forEach((a) => settle.add(a));
      leftSeen.delete(key);
    } else if (left.size) leftSeen.set(key, left);
    const start = scans.get(key);
    if (r.complete) editorSeen.delete(key);
    if (r.complete && start !== undefined) {
      const gone = d
        // only in the libraries the folder fills now: a row of a library it no longer fills was not looked for, not gone
        .prepare(
          `UPDATE version_places SET state = 'gone', gone_at = ? WHERE device = ? AND folder_id = ? AND kind = 'original' AND state <> 'gone'
             AND (checked_at IS NULL OR checked_at < ?)
             AND version_id IN (SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id IN (SELECT value FROM json_each(?)))`,
        )
        .run(now, device, folder.id, start, inLibs);
      if (Number(gone.changes)) libs.forEach((l) => touched.add(l));
      scans.delete(key);
    }
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
  if (dev.owner === "workspace" || !folders.length) return { ok: true, index };
  const st = await storageOf(dev.owner);
  const touched = new Set<string>();
  const keepOut = keptOut(st, dev.id);
  const settle = new Set<string>();
  const copies = copyFilesOn([dev.id]);
  for (const r of folders) {
    const folder = st.folders.find((f) => f.id === r.id && f.origin.host === dev.id);
    if (!folder || useOf(folder) !== "media") continue;
    const of = await librariesOf(dev.owner, folder);
    await applyFolder(dev, folder, of, r, now, index, touched, keepOut, filmed, mediaOf(st), settle, copies);
  }
  for (const id of settleLeft(settle, now, dev.name)) {
    const lib = db().prepare("SELECT library_id FROM assets WHERE id = ?").get(id) as { library_id: string } | undefined;
    if (lib) touched.add(lib.library_id);
  }
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
