import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LIBRARY_NAME, LIBRARY_SUBFOLDERS, STORAGE_ROLES, okFolderPath, type StorageState, type StorageView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import { deviceOf } from "./lib/devices";
import { env } from "./lib/env";
import { libraryPath, localDisks, parseStorageFile, storageFilePath } from "./lib/storage";

/**
 * Settings → Devices → Storage (contracts/storage.ts), mounted at /api/devices/storage by devices.ts:
 *   GET    /                        → StorageView (this account's folders, and the server's own disks when CT_LOCAL=1)
 *   POST   /library   {host, disk}  → make the Library ("Creator Toolset") in `disk` on one of this account's computers
 *   POST   /folders   {role, host, path} → use a folder you already have as footage or music
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
/** A device id this account owns (its own computer), or undefined. */
const mine = (user: string, host: string) => {
  const d = deviceOf(host);
  return d && d.owner === user ? d : undefined;
};

export const storageApp = new Hono<{ Variables: AuthVars }>();

storageApp.use("*", async (c, next) => {
  if (c.get("user").role === "visitor") return c.json({ error: "Not for guests" }, 403);
  return next();
});

/** The server's own disks only on a server run on the owner's computer (CT_LOCAL=1); a hosted server reports none. */
storageApp.get("/", async (c) => {
  const st = await readStorage(c.get("user").username);
  const view: StorageView = { ...st, serverDisks: process.env.CT_LOCAL === "1" ? await localDisks() : [] };
  return c.json(view);
});

/** The Library: "Creator Toolset" inside `disk` on one computer ("/" or "~" = its home folder). Choosing another
 *  place applies from then on: nothing moves, and the old Library's Footage and Music stay listed as sources. */
storageApp.post("/library", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const host = str(b?.host, 120);
  const disk = b?.disk;
  if (!host || !okFolderPath(disk) || !mine(user, host)) return c.json({ error: "Pick a computer and a folder" }, 400);
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
  if (!role || !host || !okFolderPath(raw) || !mine(user, host)) return c.json({ error: "Pick a role, a computer and a folder" }, 400);
  const p = raw.replace(/(.)\/+$/, "$1");
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
    if (!st.folders.some((f) => f.id === id)) return null;
    st.folders = st.folders.filter((f) => f.id !== id);
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(out) : c.json({ error: "Not found" }, 404);
});
