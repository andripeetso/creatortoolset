import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIBRARY_NAME, LIBRARY_SUBFOLDERS, STORAGE_ROLES, THIS_COMPUTER, okFolderPath, type StorageState, type StorageView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import { deviceOf, isThisMachine, listDevices } from "./lib/devices";
import { env, hostedMode } from "./lib/env";
import { addWatchFolder, removeWatchFolder, watchAllowed } from "./library/watch";
import { libraryPath, localDisks, parseStorageFile, storageFilePath } from "./lib/storage";

/**
 * Settings → Storage (contracts/storage.ts), mounted at /api/devices/storage by devices.ts:
 *   GET    /                        → StorageView (this account's folders, and the server's own disks when CT_LOCAL=1)
 *   POST   /library   {host, disk}  → make the Library ("Creator Toolset") in `disk` on one of this account's computers
 *   POST   /folders   {role, host, path} → use a folder you already have as footage or music (this computer's also go on
 *                                          the Library's watch list, which the Library and the AI Editor read)
 *   DELETE /folders/:id             → forget a folder (its marker files stay where they are)
 * Each account has its own list in $DATA_DIR/storage/<user>.json. `host` is a device id this account owns.
 * Nothing here moves a file: the folders are recorded, and each computer finds them by their marker.
 */

type C = Context<{ Variables: AuthVars }>;
const file = (user: string) => storageFilePath(env.dataDir, user);

/** Writes queue per account, so two requests never read the same list and lose one change. */
const chains = new Map<string, Promise<unknown>>();
function chained<T>(user: string, fn: () => Promise<T>): Promise<T> {
  const next = (chains.get(user) ?? Promise.resolve()).then(fn, fn);
  chains.set(user, next.catch(() => undefined));
  return next;
}

/** No file yet, or a file that is not valid JSON: an empty list (parseStorageFile logs the bad one). */
async function readStorage(user: string): Promise<StorageState> {
  const raw = await readFile(file(user), "utf-8").catch(() => "{}");
  return parseStorageFile(raw);
}

async function writeStorage(user: string, st: StorageState): Promise<void> {
  await mkdir(path.dirname(file(user)), { recursive: true });
  const tmp = `${file(user)}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(st, null, 2));
  await rename(tmp, file(user));
}

const str = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : "");
/** A device id this account may put a folder on: its own computer, or an admin's the team's AI worker (owner "workspace"). */
const mine = (c: C, host: string) => {
  const u = c.get("user");
  const d = deviceOf(host);
  return d && (d.owner === u.username || (u.role === "admin" && d.owner === "workspace")) ? d : undefined;
};
/** This computer, for the owner of a server that runs on one (not hosted): setup's Folders step records against it. */
const thisComputer = (c: C, host: string) => host === THIS_COMPUTER && !hostedMode() && c.get("user").role === "admin";

/**
 * A folder this server reads in place, so it joins the Media Library's watch list: "this computer" by name (setup's
 * Folders step), or the paired computer that is the machine this server runs on (Settings → Storage picks a computer),
 * where the server may read the person's folders at all (watchAllowed: not a hosted server).
 */
const readHere = (user: string, host: string) => host === THIS_COMPUTER || (isThisMachine(host) && watchAllowed(user));

export const storageApp = new Hono<{ Variables: AuthVars }>();

storageApp.use("*", async (c, next) => {
  if (c.get("user").role === "visitor") return c.json({ error: "Not for guests" }, 403);
  return next();
});

/** The server's own disks only on a server run on the owner's computer (CT_LOCAL=1), and only for an admin (Drives is an
 *  admin's Advanced view); a hosted server reports none. The Library's disk is read here too when its computer reports
 *  no drives (the row then has nothing else to show). */
storageApp.get("/", async (c) => {
  const u = c.get("user");
  const st = await readStorage(u.username);
  const lib = st.folders.find((f) => f.role === "library");
  const reported = lib ? deviceOf(lib.origin.host)?.report?.machine?.disks ?? [] : [];
  const libraryPath = lib && !reported.length ? lib.origin.path : undefined;
  const local = process.env.CT_LOCAL === "1" && u.role === "admin";
  // which of this account's computers is this machine: a folder added on it goes into the Library (the page asks first when it is big)
  const here = watchAllowed(u.username) ? listDevices((d) => !!mine(c, d.id) && isThisMachine(d.id)).map((d) => d.id) : [];
  const view: StorageView = { ...st, serverDisks: local ? await localDisks(libraryPath) : [], here };
  return c.json(view);
});

/** The Library: "Creator Toolset" inside `disk` on one computer ("/" or "~" = its home folder). Choosing another
 *  place applies from then on: nothing moves, and the old Library's Footage and Music stay listed as sources. */
storageApp.post("/library", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const host = str(b?.host, 120);
  const disk = b?.disk;
  if (!host || !okFolderPath(disk) || !(thisComputer(c, host) || mine(c, host))) return c.json({ error: "Pick a computer and a folder" }, 400);
  const p = libraryPath(disk);
  if (!okFolderPath(p)) return c.json({ error: "Path too long" }, 400);
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    const old = st.folders.find((f) => f.role === "library");
    if (old && old.origin.host === host && old.origin.path === p) return null;
    const now = Date.now();
    if (old) {
      st.folders = st.folders.filter((f) => f !== old);
      for (const role of ["footage", "music"] as const) {
        const at = `${old.origin.path}/${LIBRARY_SUBFOLDERS[role]}`;
        if (!st.folders.some((f) => f.role === role && f.origin.host === old.origin.host && f.origin.path === at))
          st.folders.push({ id: randomUUID(), role, name: LIBRARY_SUBFOLDERS[role], origin: { host: old.origin.host, path: at }, make: false, createdAt: now, reach: {} });
      }
    }
    st.folders.push({ id: randomUUID(), role: "library", name: LIBRARY_NAME, origin: { host, path: p }, make: true, createdAt: now, reach: {} });
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(out) : c.json({ error: "The library is already there" }, 400);
});

/** Use a folder you already have as footage or music. */
storageApp.post("/folders", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const role = STORAGE_ROLES.find((r) => r.value === b?.role)?.value;
  const host = str(b?.host, 120);
  const raw = b?.path;
  if (!role || !host || !okFolderPath(raw) || !(thisComputer(c, host) || mine(c, host))) return c.json({ error: "Pick a role, a computer and a folder" }, 400);
  // "~/…" is this computer's home folder: stored as the full path, so it matches the scan's list
  const p = (raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw).replace(/(.)\/+$/, "$1");
  // this computer's folders are read by the Library and the AI Editor through its watch list: the path is checked there
  if (readHere(user, host)) {
    const refused = await addWatchFolder(user, p);
    if (refused) return c.json({ error: refused }, 400);
  }
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    if (st.folders.some((f) => f.role === role && f.origin.host === host && f.origin.path === p)) return null;
    st.folders.push({ id: randomUUID(), role, name: p.split("/").filter(Boolean).pop() ?? p, origin: { host, path: p }, make: false, createdAt: Date.now(), reach: {} });
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(out) : c.json({ error: "That folder is already there" }, 400);
});

/** Forget a folder (its marker files stay where they are). */
storageApp.delete("/folders/:id", async (c) => {
  const user = c.get("user").username;
  const id = c.req.param("id");
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    const gone = st.folders.find((f) => f.id === id);
    if (!gone) return null;
    st.folders = st.folders.filter((f) => f !== gone);
    await writeStorage(user, st);
    return { st, gone };
  });
  if (!out) return c.json({ error: "Not found" }, 404);
  if (out.gone.role !== "library" && readHere(user, out.gone.origin.host)) await removeWatchFolder(user, out.gone.origin.path);
  return c.json(out.st);
});
