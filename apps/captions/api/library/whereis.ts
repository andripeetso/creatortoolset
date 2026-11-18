import type { PlaceKind, PlaceOn, PlaceState, WhereIs } from "../../contracts/places";
import type { Disk } from "../../contracts/storage";
import { deviceOf, isOnline } from "../lib/devices";
import { inside } from "../lib/storage";
import { libraryDb } from "./db";

/**
 * Where a version is: the one reader (local first, P1). Every screen that says where a file is (the Library's filters and
 * card marks, the clip window, Review, the editor, Copies, the AI Editor's file choice) asks here, and here reads only the
 * place rows the computers reported (version_places, contracts/places.ts PlaceState) and those computers' disks. A computer
 * with no row for a version has not been asked: "Not checked yet", never "missing".
 *
 * Computer ids: a computer paired again with a new id has an alias (device_alias); its rows were moved to the new id when
 * the alias was written (aliasDevice), and ids kept elsewhere (storage files, reports) resolve through resolveDevice.
 */

const db = () => libraryDb();

/** The id a computer has now: an old id followed through its aliases (a chain of re-pairs), else the id itself. */
export function resolveDevice(id: string): string {
  let at = id;
  for (let i = 0; i < 10; i++) {
    const r = db().prepare("SELECT new_id FROM device_alias WHERE old_id = ?").get(at) as { new_id: string } | undefined;
    if (!r) return at;
    at = r.new_id;
  }
  return at;
}

/**
 * Computer `oldIds` is now `newId` (paired again without its machine id, lib/devices.ts pairDevice): the alias is kept and
 * every row keyed by the old ids moves to the new one, so its places, indexed files and copies stay its own.
 */
export function aliasDevice(oldIds: string[], newId: string, now = Date.now()): void {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    for (const old of oldIds) {
      if (old === newId) continue;
      d.prepare("INSERT INTO device_alias (old_id, new_id, at) VALUES (?, ?, ?) ON CONFLICT (old_id) DO UPDATE SET new_id = excluded.new_id, at = excluded.at").run(old, newId, now);
      // a chain: whatever pointed at the old id points at the new one
      d.prepare("UPDATE device_alias SET new_id = ? WHERE new_id = ?").run(newId, old);
      d.prepare("UPDATE OR REPLACE version_places SET device = ? WHERE device = ?").run(newId, old);
      d.prepare("UPDATE asset_versions SET mac_device = ? WHERE mac_device = ?").run(newId, old);
      d.prepare("UPDATE asset_versions SET from_device = ? WHERE from_device = ?").run(newId, old);
      d.prepare("UPDATE OR IGNORE library_copies SET device = ? WHERE device = ?").run(newId, old);
    }
    d.exec("COMMIT");
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  }
}

/**
 * The drive a path is on when that drive is not connected on the computer now: a reported disk that holds it and is away,
 * or a /Volumes/<name> path whose volume the computer (which reported its disks) no longer lists. Undefined otherwise.
 */
export function awayDisk(p: string, disks: Disk[] | undefined): string | undefined {
  if (!disks?.length) return undefined;
  let best: Disk | undefined;
  for (const d of disks) if (d.path !== "/" && inside(p, d.path) !== null && (!best || d.path.length > best.path.length)) best = d;
  if (best) return best.away ? best.name : undefined;
  const vol = /^\/Volumes\/([^/]+)\//.exec(p)?.[1];
  return vol;
}

type Row = {
  version_id: string;
  device: string;
  kind: PlaceKind;
  folder_id: string;
  path: string;
  state: PlaceState;
  checked_at: number | null;
};

/** Each version's library and whether the server holds its original or a proxy. */
type VRow = { id: string; library_id: string; source_key: string; proxy: number };

/**
 * whereIs for many versions at once (at most a page's worth): every computer with a place row for it, best first
 * (verified, found, unchecked, gone), with its name, whether it is online, a drive that is not connected, and the folder's
 * state when its location agent said it is not readable. Versions that do not exist are left out.
 */
export function whereIsMany(versionIds: string[], folderStateOf?: (device: string, folder: string) => PlaceOn["folderState"]): Map<string, WhereIs> {
  const ids = JSON.stringify([...new Set(versionIds)]);
  const versions = db()
    .prepare(
      `SELECT v.id, a.library_id, v.source_key,
         EXISTS (SELECT 1 FROM derivatives x WHERE x.version_id = v.id AND x.kind = 'proxy' AND x.storage_key IS NOT NULL) AS proxy
       FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id IN (SELECT value FROM json_each(?))`,
    )
    .all(ids) as VRow[];
  const rows = db()
    .prepare("SELECT version_id, device, kind, folder_id, path, state, checked_at FROM version_places WHERE version_id IN (SELECT value FROM json_each(?))")
    .all(ids) as Row[];
  const rank: Record<PlaceState, number> = { verified: 0, found: 1, unchecked: 2, gone: 3 };
  const out = new Map<string, WhereIs>();
  for (const v of versions) {
    const byDevice = new Map<string, PlaceOn>();
    for (const r of rows.filter((x) => x.version_id === v.id).sort((a, b) => rank[a.state] - rank[b.state])) {
      const dev = deviceOf(r.device);
      const on = byDevice.get(r.device) ?? { device: r.device, name: dev?.name ?? "A computer", online: isOnline(r.device) };
      if (r.kind === "proxy") on.proxy ??= { state: r.state, path: r.path };
      else if (!on.original) {
        on.original = { state: r.state, path: r.path, folder: r.folder_id, checkedAt: r.checked_at };
        // a row verified or found was just listed there, and gone needs a whole listing: its drive is connected. Only a
        // row not checked may be on a drive that went away (the computer leaves some drives out of its list: read-only,
        // small, hidden ones)
        const away = r.state === "unchecked" ? awayDisk(r.path, dev?.report?.machine?.disks) : undefined;
        if (away) on.diskAway = away;
        const fs = r.folder_id ? folderStateOf?.(r.device, r.folder_id) : undefined;
        if (fs) on.folderState = fs;
      }
      byDevice.set(r.device, on);
    }
    out.set(v.id, {
      versionId: v.id,
      library: v.library_id,
      computers: [...byDevice.values()],
      server: { original: !v.source_key.startsWith("mac:"), proxy: !!v.proxy },
    });
  }
  return out;
}

export const whereIs = (versionId: string, folderStateOf?: Parameters<typeof whereIsMany>[1]): WhereIs | null =>
  whereIsMany([versionId], folderStateOf).get(versionId) ?? null;

/** "On this computer" as SQL for a Library filter, version alias `v`: the original verified or found on computer `?`.
 *  A drive that goes away turns its rows unchecked in the same report (report.ts), so no disk join is needed. */
export const ON_COMPUTER_SQL = `EXISTS (SELECT 1 FROM version_places op WHERE op.version_id = v.id AND op.device = ? AND op.kind = 'original' AND op.state IN ('verified','found'))`;
/** "Missing on <computer>": its folder was listed whole there and the file was not in it. */
export const GONE_ON_COMPUTER_SQL = `EXISTS (SELECT 1 FROM version_places gp WHERE gp.version_id = v.id AND gp.device = ? AND gp.kind = 'original' AND gp.state = 'gone')
  AND NOT EXISTS (SELECT 1 FROM version_places hp WHERE hp.version_id = v.id AND hp.device = ? AND hp.kind = 'original' AND hp.state IN ('verified','found'))`;

/**
 * The guard before the server removes its own original (P4 calls it; nothing does yet): the server's full sha256 equals the
 * sha256 a computer read of its own copy, verified after the server's file was written. A quick fingerprint, a size match or
 * a "mac:" sha256 never passes.
 */
export function mayRemoveServerCopy(versionId: string): { ok: true; device: string } | { ok: false; why: string } {
  const v = db().prepare("SELECT full_sha256, sha256, created_at FROM asset_versions WHERE id = ?").get(versionId) as { full_sha256: string | null; sha256: string; created_at: number } | undefined;
  if (!v) return { ok: false, why: "no such version" };
  if (!v.full_sha256 || !/^[0-9a-f]{64}$/.test(v.full_sha256)) return { ok: false, why: "the server's copy has no full sha256" };
  const p = db()
    .prepare(
      `SELECT device FROM version_places WHERE version_id = ? AND kind = 'original' AND state = 'verified' AND sha256 = ? AND verified_at >= ? ORDER BY verified_at DESC LIMIT 1`,
    )
    .get(versionId, v.full_sha256, v.created_at) as { device: string } | undefined;
  return p ? { ok: true, device: p.device } : { ok: false, why: "no computer has a verified copy with the same sha256" };
}
