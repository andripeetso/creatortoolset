import { FOLDER_STATES, REPORT_FILES_MAX, type FolderState, type RelayFolder, type ReportAnswer, type ReportFile, type ReportFolder } from "../../contracts/places";
import { EVERY_WORKSPACE, editorDirsOf, notFootage, okFolderPath, type StorageFolder } from "../../contracts/storage";
import type { Device } from "../../contracts/providers";
import type { SessionUser } from "../users";
import { storageOf, updateFolder } from "../devices-storage";
import { projectOf } from "../lib/project-of";
import { inside } from "../lib/storage";
import { ownedProjects, sharedProjects } from "../lib/workshop/workspace";
import { isTeamMember } from "../lib/workspaces";
import { ensureLibrary, librariesHere, libraryChanged } from "./access";
import { libraryDb } from "./db";
import { enqueueJob } from "./jobs";
import { setTrashedAt, trashHeld } from "./trash";
import { indexOnMac, type OnMacIndex } from "./on-mac";

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

/** The libraries a folder fills: one per workspace it is in (made when missing), every workspace's for "*". A member
 *  never gets a library of a workspace they were given: the owner's one is used, locate only. */
export async function librariesOf(owner: string, f: StorageFolder): Promise<FolderLibrary[]> {
  const ws = await workspacesOf(owner, f);
  const owned = await ownedProjects(owner);
  const ids = ws === "*" ? owned.map((p) => p.id) : ws;
  const given = new Map((await sharedProjects(owner)).map((p) => [p.id, p.owner]));
  const member = isTeamMember(owner);
  // an account with no workspaces: its one library. A member given workspaces but none of their own makes none (theirs are the owner's)
  if (!ids.length) {
    if (member && given.size) return [];
    const one = await ensureLibrary(owner);
    return one ? [{ id: one, locate: false }] : [];
  }
  const out: FolderLibrary[] = [];
  const add = (id: string, locate: boolean) => {
    if (!out.some((l) => l.id === id)) out.push({ id, locate });
  };
  for (const id of ids) {
    const from = given.get(id);
    if (from) {
      const lib = (await librariesHere(from, id))[0]?.id;
      if (lib) add(lib, true);
    } else if (!member || owned.some((p) => p.id === id)) {
      const lib = await ensureLibrary(owner, id);
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

/** Moves the clips made from the files `where` (a condition on version_places p) matches out of the library, unless held. */
function leaveLibrary(dev: Device, folderId: string, inLibs: string, libs: string[], touched: Set<string>, now: number, where: string, args: string[], what: string): void {
  const made = db()
    .prepare(
      `SELECT DISTINCT a.id FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
       WHERE p.device = ? AND p.folder_id = ? AND p.kind = 'original' AND ${where} AND v.source_key LIKE 'mac:%' AND a.trashed_at IS NULL
         AND a.library_id IN (SELECT value FROM json_each(?))`,
    )
    .all(dev.id, folderId, ...args, inLibs) as { id: string }[];
  for (const a of made) {
    const held = trashHeld(a.id, now);
    if (held) {
      console.log(`[library] ${dev.name}: ${what} stays in the library (${held}), not moved to the trash`);
      continue;
    }
    setTrashedAt(a.id, now);
    libs.forEach((l) => touched.add(l));
  }
}

type Hit = { version_id: string; library_id: string; vbytes: number; vquick: string | null; state: string; bytes: number | null; mtime: number | null; folder_id: string };

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
}

/** One folder's page of a listing from computer `device`: place rows written, the files no version matched answered. */
async function applyFolder(dev: Device, folder: StorageFolder, libraries: FolderLibrary[], r: ReportFolder, now: number, index: ReportAnswer["index"], touched: Set<string>, keepOut: string[]): Promise<void> {
  const d = db();
  const device = dev.id;
  const libs = libraries.map((l) => l.id);
  const locate = new Set(libraries.filter((l) => l.locate).map((l) => l.id));
  const inLibs = JSON.stringify(libs);
  // a locate-only library is matched, never trashed into
  const inOwn = JSON.stringify(libs.filter((l) => !locate.has(l)));
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
    // an AI Editor folder this page names that earlier pages of the listing indexed as footage: its clips leave now
    for (const dir of fresh) {
      const hit = placed.find((x) => x.rel.startsWith(`${dir}/`))!;
      const full = hit.f.path.slice(0, hit.f.path.length - hit.rel.length) + dir;
      leaveLibrary(dev, folder.id, inOwn, libs, touched, now, "(p.path = ? OR substr(p.path, 1, length(?) + 1) = ? || '/')", [full, full, full], full);
    }
    for (const { f, rel } of placed) {
      // not footage: an AI Editor folder, a half-written file, or anything inside a Projects or Exports folder
      if (notFootage(rel, editorDirs) || keepOut.some((k) => inside(f.path, k) !== null)) {
        // indexed here before this rule: the clip leaves the library through the trash (never while in Review or shared);
        // the file on the computer stays
        // a locate-only library is never trashed into (leaveLibrary: held clips stay, as before)
        leaveLibrary(dev, folder.id, inOwn, libs, touched, now, "p.path = ?", [f.path], f.path);
        continue;
      }
      const hits = d
        .prepare(
          `SELECT p.version_id, a.library_id, v.bytes AS vbytes, v.quick AS vquick, p.state, p.bytes, p.mtime, p.folder_id
           FROM version_places p JOIN asset_versions v ON v.id = p.version_id JOIN assets a ON a.id = v.asset_id
           WHERE p.device = ? AND p.kind = 'original' AND p.folder_id IN (?, '') AND p.path = ? AND a.trashed_at IS NULL
             AND a.library_id IN (SELECT value FROM json_each(?))`,
        )
        .all(device, folder.id, f.path, inLibs) as Hit[];
      const done = new Set<string>();
      for (const h of hits) {
        const same = f.bytes === h.vbytes && (!f.quick || !h.vquick || f.quick === h.vquick);
        const next = !same ? "gone" : f.quick && h.vquick ? "verified" : h.state === "verified" && h.bytes === f.bytes && h.mtime === f.mtime ? "verified" : "found";
        upsert(h.version_id, device, folder.id, next === "verified" && !f.quick ? { ...f, quick: h.vquick ?? undefined } : f, next, "scan", now);
        if (next !== "gone") done.add(h.library_id);
        touched.add(h.library_id);
      }
      for (const lib of libs.filter((l) => !done.has(l))) {
        // a member's locate-only library: a file it does not have is not for indexing (indexForDevice skips it too)
        // the same file indexed before (an upload, another computer's copy): its fingerprint and size
        let found = f.quick
          ? (d.prepare("SELECT v.id FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? AND a.trashed_at IS NULL AND v.bytes = ? AND v.quick = ?").all(lib, f.bytes, f.quick) as { id: string }[]).map((x) => ({ id: x.id, state: "verified" }))
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
export async function applyReport(dev: Device, folders: ReportFolder[], now = Date.now()): Promise<ReportAnswer> {
  const index: ReportAnswer["index"] = [];
  if (dev.owner === "workspace" || !folders.length) return { ok: true, index };
  const st = await storageOf(dev.owner);
  const touched = new Set<string>();
  const keepOut = keptOut(st, dev.id);
  for (const r of folders) {
    const folder = st.folders.find((f) => f.id === r.id && f.origin.host === dev.id);
    if (!folder || useOf(folder) !== "media") continue;
    const of = await librariesOf(dev.owner, folder);
    await applyFolder(dev, folder, of, r, now, index, touched, keepOut);
  }
  for (const l of touched) libraryChanged(l);
  return { ok: true, index };
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
  if (keptOut(st, dev.id).some((k) => inside(nfc(x.path), k) !== null)) return "Inside a Projects or Exports folder: not footage";
  const versions: Array<{ library: string; versionId?: string; duplicateOf?: string }> = [];
  for (const { id: library, locate } of await librariesOf(dev.owner, folder)) {
    // a member's workspace is only located, never indexed into (applyFolder answers no file for it)
    if (locate) continue;
    const r = await indexOnMac(library, dev.owner, { ...x, path: nfc(x.path), device: dev.id, folder: folder.id });
    versions.push({ library, ...("versionId" in r ? { versionId: r.versionId } : "duplicateOf" in r ? { duplicateOf: r.duplicateOf } : {}) });
  }
  return { versions };
}
