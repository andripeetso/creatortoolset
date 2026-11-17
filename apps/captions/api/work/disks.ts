import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";
import path from "node:path";
import type { Disk, ShareFs } from "../../contracts/storage";

/**
 * The network shares a Linux computer has mounted (/proc/mounts), as the Mac's report names its disks (contracts
 * storage.ts Disk), so the server finds a file on them by its share (places.ts rootKey). Only the share's server, its
 * name and where it is mounted are read: never the mount options, which can carry a user name or a password.
 */
const FS: Record<string, ShareFs> = { cifs: "smb", smb3: "smb", nfs: "nfs", nfs4: "nfs" };

/** /proc/mounts writes a space, tab, newline or backslash in a path as \040, \011, \012, \134. */
const unescape = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));

/** The shares in a /proc/mounts text (`free`: a mount's free space in GB, 0 when not known yet). */
export function sharesIn(mounts: string, free: (dir: string) => number = cachedFree): Disk[] {
  const out: Disk[] = [];
  for (const line of mounts.split("\n")) {
    // device, mount point, type; the options after them are never looked at
    const [dev, dir, type] = line.split(" ");
    const fs = type ? FS[type] : undefined;
    if (!fs || !dev || !dir) continue;
    const source = unescape(dev);
    // smb: //server/share[/sub]; nfs: server:/export
    const m = fs === "smb" ? /^\/\/([^/]+)\/([^/]+)/.exec(source) : /^([^:/]+):(\/.*)$/.exec(source);
    if (!m) continue;
    const at = unescape(dir);
    // a source may name the NAS user ("//tiny@nas/share"): only the host after it is the server
    const server = m[1]!.slice(m[1]!.lastIndexOf("@") + 1).toLowerCase();
    out.push({ name: path.basename(at) || at, path: at, freeGb: free(at), network: true, server, fs, share: m[2]! });
  }
  return out;
}

/** How often a mount's free space is asked again. */
const FREE_EVERY_MS = 5 * 60_000;
const free = new Map<string, { gb: number; at: number; asking: boolean }>();

/**
 * A mount's free space as last read, never waited for: a share whose server hangs would hold the worker's claim, and
 * its statfs a thread, for minutes. Read again in the background every FREE_EVERY_MS, one read in flight a mount.
 */
export function cachedFree(dir: string, ask: (dir: string) => Promise<{ bavail: number; bsize: number }> = statfs, now = Date.now()): number {
  let f = free.get(dir);
  if (!f) free.set(dir, (f = { gb: 0, at: 0, asking: false }));
  if (!f.asking && now - f.at >= FREE_EVERY_MS) {
    const e = f;
    e.asking = true;
    void ask(dir)
      .then(
        (s) => void (e.gb = Math.round(((s.bavail * s.bsize) / 1024 ** 3) * 10) / 10),
        () => void (e.gb = 0),
      )
      .finally(() => {
        e.asking = false;
        e.at = Date.now();
      });
  }
  return f.gb;
}

/** This computer's mounted network shares; none off Linux. */
export function machineDisks(): Disk[] {
  if (process.platform !== "linux") return [];
  try {
    return sharesIn(readFileSync("/proc/mounts", "utf8"));
  } catch {
    return [];
  }
}
