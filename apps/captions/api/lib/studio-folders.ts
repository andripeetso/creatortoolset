import { EVERY_WORKSPACE, type StorageFolder } from "../../contracts/storage";

/** A hostname as a device of an account: the one place a hostname becomes a device id (the one-time import, devices-storage.ts). */
export type HostLookup = (host: string) => { id: string; owner: string } | undefined;

/** One folder, once: the same workspaces, computer and path, whatever its use (PRD decision 1). */
const keyOf = (f: StorageFolder) => [f.origin.host, f.origin.path, [...(f.workspaces ?? [f.workspace ?? EVERY_WORKSPACE])].sort().join(",")].join("\n");

/**
 * The plug-in's Settings → Folders rows (keyed by hostname) as account rows (keyed by device id), per account. A computer
 * no account has is kept under its hostname, so the page can say "Computer not found" (never dropped). A row from before
 * workspaces was every workspace's. Pure: the caller writes them.
 */
export function studioRows(studio: StorageFolder[], lookup: HostLookup, fallbackOwner: string): Map<string, StorageFolder[]> {
  const out = new Map<string, StorageFolder[]>();
  for (const f of studio) {
    const d = lookup(f.origin.host);
    const owner = d?.owner ?? fallbackOwner;
    const host = d?.id ?? f.origin.host;
    const reach = Object.fromEntries(Object.entries(f.reach ?? {}).map(([h, r]) => [lookup(h)?.id ?? h, r]));
    const role = (f.role as string) === "music" ? "footage" : f.role;
    out.set(owner, [...(out.get(owner) ?? []), { ...f, role, origin: { ...f.origin, host }, reach, workspace: f.workspace ?? EVERY_WORKSPACE }]);
  }
  return out;
}

/**
 * An account's list with the imported rows in. A row with the same key as an imported one is replaced by it: the imported
 * id stays (the studio wrote that id into the computer's marker), and both reach maps are kept.
 * shortcut: the marker's own id is not read (it is on the computer, not here); the studio's id is the one the markers
 * were written with, so it wins. Upgrade: read the marker when a duplicate's two ids disagree.
 * Running it again changes nothing.
 */
export function mergeStudio(current: StorageFolder[], incoming: StorageFolder[]): StorageFolder[] {
  const byKey = new Map<string, StorageFolder>();
  for (const f of incoming) if (!byKey.has(keyOf(f))) byKey.set(keyOf(f), f);
  const kept = current.flatMap((f): StorageFolder[] => {
    const again = byKey.get(keyOf(f));
    if (!again) return [f];
    byKey.set(keyOf(f), { ...again, reach: { ...f.reach, ...again.reach } });
    return [];
  });
  // the imported ones keep their place in the file's order, after the account's own
  return [...kept, ...byKey.values()];
}

/** The ids mergeStudio dropped from `current`, each with the id of the row it became in `merged` (version_places.folder_id follows them). */
export function replacedIds(current: StorageFolder[], merged: StorageFolder[]): Map<string, string> {
  const ids = new Set(merged.map((f) => f.id));
  const byKey = new Map(merged.map((f) => [keyOf(f), f.id]));
  return new Map(current.flatMap((f) => (ids.has(f.id) || !byKey.has(keyOf(f)) ? [] : [[f.id, byKey.get(keyOf(f))!] as const])));
}
