import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVERY_WORKSPACE, LIBRARY_NAME, LIBRARY_SUBFOLDERS, STORAGE_ROLES, THIS_COMPUTER, folderIn, okFolderPath, type StorageFolder, type StorageState, type StorageView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import { deviceOf, isThisMachine, listDevices } from "./lib/devices";
import { env, hostedMode } from "./lib/env";
import { addWatchFolder, removeWatchFolder, watchAllowed } from "./library/watch";
import { inside, libraryPath, localDisks, mediaFolders, mountOf, parseStorageFile, storageFilePath, withMounts } from "./lib/storage";
import { keptApp } from "./kept";
import { libraryDb } from "./library/db";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { inProjectOf, projectOf } from "./lib/project-of";
import { ownedProjects, sharedProjects } from "./lib/workshop/workspace";
import { ensureLibrary } from "./library/access";

/**
 * Settings → Folders (contracts/storage.ts), mounted at /api/devices/storage by devices.ts:
 *   GET    /                        → StorageView (this account's folders, and the server's own disks when CT_LOCAL=1);
 *                                     ?all=1: every workspace's folders
 *   POST   /library   {host, disk}  → make the Library ("Creator Toolset") in `disk` on one of this account's computers
 *   POST   /folders   {role, host, path} → use a folder you already have as a Media folder (this computer's also go on
 *                                          the Library's watch list, which the Library and the AI Editor read), or as the
 *                                          workspace's Finals folder (role "finals": in place of the one it had; each
 *                                          Workshop project's subfolder is read when the project asks, workshop.ts sessionFinals)
 *   PATCH  /folders/:id {workspace} → move a Media folder to another workspace; null = every workspace
 *   DELETE /folders/:id             → forget a folder (its marker files stay where they are)
 *   /kept                           → what this account keeps in the server's data folder, and Empty (api/kept.ts)
 * Each account has its own list in $DATA_DIR/storage/<user>.json, and each workspace its own folders in it (a folder's
 * `workspace`, stamped when it is added; one from before belongs to the first brand, project-of.ts; EVERY_WORKSPACE =
 * all of them). A list is the folders of the workspace the request works in, and a new folder goes to that workspace
 * (Settings sends the one it shows, X-CT-Workspace); a folder is moved or forgotten by its id, whatever workspace it is
 * in. `host` is a device id this account owns.
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
  await writeFile(tmp, JSON.stringify({ ...st, folders: mediaFolders(st.folders) }, null, 2));
  await rename(tmp, file(user));
}

/**
 * The account's folders kept to a workspace being deleted (lib/workspace-delete.ts): only their entries go, never a file
 * in them. One used in every workspace stays. The workspace's Media Library, which read them, is deleted with it.
 */
export async function workspaceStorageFolders(user: string, has: (ws?: string) => boolean): Promise<{ n: number; drop: () => Promise<void> }> {
  // one in several workspaces only leaves this one, and goes when this was the last of them
  const left = (f: StorageFolder) => (f.workspace === EVERY_WORKSPACE ? null : (f.workspaces ?? [f.workspace]).filter((w) => !has(w)));
  const n = (await readStorage(user)).folders.filter((f) => left(f)?.length === 0).length;
  return {
    n,
    drop: () =>
      chained(user, async () => {
        const st = await readStorage(user);
        st.folders = st.folders.flatMap((f) => {
          const l = left(f);
          if (!l) return [f];
          if (!l.length) return [];
          return f.workspaces && l.length < f.workspaces.length ? [placedIn(f, l as string[])] : [f];
        });
        await writeStorage(user, st);
      }),
  };
}

/** The workspaces a folder is in, by id (`of`: project-of.ts projectOf, for one from before), or null for every workspace. */
const placesOf = (f: StorageFolder, of: (own?: string) => string): string[] | null =>
  f.workspace === EVERY_WORKSPACE ? null : (f.workspaces ?? [of(f.workspace)]);
/** A folder put in these workspaces (null: every workspace): one is its `workspace`, two or more its `workspaces` too. */
export function placedIn(f: StorageFolder, to: string[] | null): StorageFolder {
  const { workspaces: _, ...rest } = f;
  if (!to) return { ...rest, workspace: EVERY_WORKSPACE };
  return { ...rest, workspace: to[0], ...(to.length > 1 ? { workspaces: to } : {}) };
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

/** The workspace a folder is in, as a page names it: its own, the first brand's for one from before (project-of.ts), or EVERY_WORKSPACE. */
type Named = (f: StorageFolder) => string | undefined;

/** Which folders are this request's workspace's, the id a new one is stamped with, and the workspace each folder is in. */
async function scopeOf(c: C): Promise<{ mine: (f: StorageFolder) => boolean; workspace?: string; named: Named }> {
  const u = c.get("user");
  const [inWs, of] = await Promise.all([inCurrentWorkspace(u), projectOf(u)]);
  const workspace = inWs ? await currentWorkspaceId(u) : undefined;
  const named: Named = (f) => (f.workspace === EVERY_WORKSPACE || !of ? f.workspace : of(f.workspace));
  return { mine: (f) => folderIn(f, inWs), ...(workspace ? { workspace } : {}), named };
}
/** The list the page gets: the folders `mine` keeps, each with the workspace it is in and the account's computers that reach it through a connected share (lib/storage.ts withMounts). */
const shown = (st: StorageState, mine: (f: StorageFolder) => boolean, user: string, named: Named): StorageState => ({
  ...st,
  folders: withMounts(st.folders.filter(mine), listDevices((d) => d.owner === user).map((d) => ({ id: d.id, disks: d.report?.machine?.disks }))).map((f) => {
    const workspace = named(f);
    return workspace ? { ...f, workspace } : f;
  }),
});

/**
 * The workspaces that read a folder on this computer through their Library's watch list: the ones that list its path
 * as Media ("" for an account with no workspace). `of`: project-of.ts projectOf.
 */
async function readersOf(user: string, of: ((own?: string) => string) | null, folders: StorageFolder[], at: StorageFolder["origin"]): Promise<Set<string>> {
  // a Finals folder is read project by project, never as footage (library/watch.ts watchFinals)
  const same = folders.filter((f) => f.role !== "library" && f.role !== "finals" && f.origin.host === at.host && f.origin.path === at.path);
  if (!of) return new Set(same.length ? [""] : []);
  const every = same.some((f) => f.workspace === EVERY_WORKSPACE) ? [...(await ownedProjects(user)), ...(await sharedProjects(user))].map((p) => p.id) : [];
  return new Set([...every, ...same.flatMap((f) => placesOf(f, of) ?? [])]);
}

/** Puts a folder on the watch list of one workspace's Library ("" = the account has no workspace). The refusal, or null. */
async function watchIn(user: string, folderPath: string, workspace: string): Promise<string | null> {
  if (!workspace) return addWatchFolder(user, folderPath);
  const library = await ensureLibrary(user, workspace);
  return library ? addWatchFolder(user, folderPath, library) : null;
}

/**
 * After a folder on this computer left a workspace (moved or forgotten): the Library of each workspace that still lists
 * its path keeps reading it, with its entry as it was; the others stop. The files already in a Library stay.
 */
async function unwatch(user: string, folderPath: string, was: Set<string>, now: Set<string>): Promise<void> {
  if (![...was].some((id) => !now.has(id))) return;
  const keep = new Set<string>();
  for (const id of now) {
    const library = await (id ? ensureLibrary(user, id) : ensureLibrary(user));
    if (library) keep.add(library);
  }
  await removeWatchFolder(user, folderPath, keep);
  // one that lists the folder but did not read it yet starts now; one that already does is left as it is
  for (const id of now) await watchIn(user, folderPath, id);
}

/** Whether a workspace's Media Library uploads what is added from a computer (`upload`: true or "all" or "proxies"; false or
 *  "none" keeps the files where they are), so the server has a copy to work from. */
const keepsCopies = (workspace: string): boolean =>
  (libraryDb().prepare("SELECT json_extract(settings, '$.upload') AS v FROM libraries WHERE workspace_id = ?").all(workspace) as { v: unknown }[])
    .some((r) => r.v === 1 || r.v === "all" || r.v === "proxies");

/** The folders whose workspace keeps copies on the server (keepsCopies), by id: a folder from before workspaces is the first brand's. */
async function copiedFolders(u: AuthVars["user"], folders: StorageFolder[]): Promise<string[]> {
  const rows = libraryDb().prepare("SELECT DISTINCT workspace_id AS id FROM libraries").all() as { id: string }[];
  const out = new Set<string>();
  for (const { id } of rows) {
    // a person with no workspace keeps their library under their own name; any other id must be one of their workspaces
    const inWs = id === u.username ? () => true : await inProjectOf(u, id);
    if (!inWs || !keepsCopies(id)) continue;
    for (const f of folders) if (folderIn(f, inWs)) out.add(f.id);
  }
  return [...out];
}

export const storageApp = new Hono<{ Variables: AuthVars }>();

storageApp.use("*", async (c, next) => {
  if (c.get("user").role === "visitor") return c.json({ error: "Not for guests" }, 403);
  return next();
});

storageApp.route("/kept", keptApp);

/** The server's own disks only on a server run on the owner's computer (CT_LOCAL=1), and only for an admin (Drives is an
 *  admin's Advanced view); a hosted server reports none. The Library's disk is read here too when its computer reports
 *  no drives (the row then has nothing else to show). */
storageApp.get("/", async (c) => {
  const u = c.get("user");
  // ?all=1: every workspace's folders (setting up another computer: it helps with all of them), with `copied`
  const all = c.req.query("all") === "1";
  const scope = await scopeOf(c);
  const st = shown(await readStorage(u.username), all ? () => true : scope.mine, u.username, scope.named);
  const lib = st.folders.find((f) => f.role === "library");
  const reported = lib ? deviceOf(lib.origin.host)?.report?.machine?.disks ?? [] : [];
  const libraryPath = lib && !reported.length ? lib.origin.path : undefined;
  const local = process.env.CT_LOCAL === "1" && u.role === "admin";
  // which of this account's computers is this machine: a folder added on it goes into the Library (the page asks first when it is big)
  const here = watchAllowed(u.username) ? listDevices((d) => !!mine(c, d.id) && isThisMachine(d.id)).map((d) => d.id) : [];
  const view: StorageView = { ...st, serverDisks: local ? await localDisks(libraryPath) : [], here, copies: keepsCopies(scope.workspace ?? u.username), ...(all ? { copied: await copiedFolders(u, st.folders) } : {}) };
  return c.json(view);
});

/** The Library: "Creator Toolset" inside `disk` on one computer ("/" or "~" = its home folder). Choosing another
 *  place applies from then on: nothing moves, and the old Library's Footage stays listed as a Media folder. */
storageApp.post("/library", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const host = str(b?.host, 120);
  const disk = b?.disk;
  if (!host || !okFolderPath(disk) || !(thisComputer(c, host) || mine(c, host))) return c.json({ error: "Needs a computer and a folder" }, 400);
  const p = libraryPath(disk);
  if (!okFolderPath(p)) return c.json({ error: "Path too long" }, 400);
  const { mine: here, workspace, named } = await scopeOf(c);
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    const old = st.folders.find((f) => f.role === "library" && here(f));
    if (old && old.origin.host === host && old.origin.path === p) return null;
    const now = Date.now();
    if (old) {
      st.folders = st.folders.filter((f) => f !== old);
      const at = `${old.origin.path}/${LIBRARY_SUBFOLDERS.footage}`;
      if (!st.folders.some((f) => f.role === "footage" && f.origin.host === old.origin.host && f.origin.path === at))
        st.folders.push({ id: randomUUID(), role: "footage", name: LIBRARY_SUBFOLDERS.footage, origin: { host: old.origin.host, path: at }, make: false, createdAt: now, reach: {}, ...(workspace ? { workspace } : {}) });
    }
    const mount = mountOf(p, deviceOf(host)?.report?.machine?.disks);
    st.folders.push({ id: randomUUID(), role: "library", name: LIBRARY_NAME, origin: { host, path: p }, make: true, createdAt: now, reach: {}, ...(workspace ? { workspace } : {}), ...(mount ? { mount } : {}) });
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(shown(out, here, user, named)) : c.json({ error: "That folder is already there" }, 400);
});

/** Use a folder you already have as a Media folder, or as the workspace's Finals folder. */
storageApp.post("/folders", async (c) => {
  const user = c.get("user").username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  // "music" from an older app is footage: the Media Library sorts songs and sound effects itself
  const role = b?.role === "finals" ? "finals" : b?.role === "music" ? "footage" : STORAGE_ROLES.find((r) => r.value === b?.role)?.value;
  const host = str(b?.host, 120);
  const raw = b?.path;
  if (!role || !host || !okFolderPath(raw) || !(thisComputer(c, host) || mine(c, host))) return c.json({ error: "Needs a computer and a folder" }, 400);
  // "~/…" is this computer's home folder: stored as the full path, so it matches the scan's list
  const p = (raw === "~" || raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(1)) : raw).replace(/(.)\/+$/, "$1");
  const { mine: here, workspace, named } = await scopeOf(c);
  // a folder inside one of this workspace's Media folders is in the Media Library already
  const outer = role === "footage" && (await readStorage(user)).folders.find((f) => here(f) && f.role === "footage" && f.origin.host === host && !!inside(p, f.origin.path));
  if (outer) return c.json({ error: `That folder is already in ${outer.name}` }, 400);
  // this computer's folders are read by the Library and the AI Editor through its watch list: the path is checked there.
  // A Finals folder is not footage: only its projects' subfolders are read, into Finals (library/watch.ts watchFinals)
  if (role !== "finals" && readHere(user, host)) {
    const refused = await addWatchFolder(user, p);
    if (refused) return c.json({ error: refused }, 400);
  }
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    if (st.folders.some((f) => here(f) && f.role === role && f.origin.host === host && f.origin.path === p)) return null;
    if (role === "finals") st.folders = st.folders.filter((f) => !(here(f) && f.role === "finals"));
    // the share its drive is on that computer, so another computer can be told how to connect it (never a password)
    const mount = mountOf(p, deviceOf(host)?.report?.machine?.disks);
    st.folders.push({ id: randomUUID(), role, name: p.split("/").filter(Boolean).pop() ?? p, origin: { host, path: p }, make: false, createdAt: Date.now(), reach: {}, ...(workspace ? { workspace } : {}), ...(mount ? { mount } : {}) });
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(shown(out, here, user, named)) : c.json({ error: "That folder is already there" }, 400);
});

/**
 * Which of the account's workspaces a Media folder is in: `workspaces`, one or more, or null for every
 * workspace (`workspace`, one id or null, from before).
 * On this computer the Library of each workspace it is now in starts reading it (refused with the reason when the
 * folder is not there now), and the one it left stops. Finished videos stays one folder per workspace: never moved.
 */
storageApp.patch("/folders/:id", async (c) => {
  const u = c.get("user");
  const user = u.username;
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const asked = b && "workspaces" in b ? b.workspaces : b?.workspace === null ? null : [b?.workspace];
  const to = asked === null ? null : Array.isArray(asked) && asked.every((w) => typeof w === "string" && w) ? [...new Set(asked as string[])] : [];
  const of = await projectOf(u);
  if (!of || to?.length === 0) return c.json({ error: "Workspace not found" }, 400);
  for (const w of to ?? []) if (!(await inProjectOf(u, w))) return c.json({ error: "Workspace not found" }, 400);
  const { mine: here, named } = await scopeOf(c);
  const before = (await readStorage(user)).folders;
  const f = before.find((x) => x.id === id);
  if (!f) return c.json({ error: "Not found" }, 404);
  if (f.role === "library" || f.role === "finals") return c.json({ error: `${f.role === "library" ? "Exports" : "Finals"} is one folder per workspace` }, 400);
  const moved = (list: StorageFolder[]) => list.map((x) => (x.id === id ? placedIn(x, to) : x));
  const clash = (list: StorageFolder[]) =>
    list.some((x) => {
      if (x.id === id || x.role !== f.role || x.origin.host !== f.origin.host || x.origin.path !== f.origin.path) return false;
      const in_ = placesOf(x, of);
      return !to || !in_ || in_.some((w) => to.includes(w));
    });
  if (clash(before)) return c.json({ error: "That folder is already there" }, 400);
  const watched = readHere(user, f.origin.host);
  const was = watched ? await readersOf(user, of, before, f.origin) : new Set<string>();
  const now = watched ? await readersOf(user, of, moved(before), f.origin) : new Set<string>();
  for (const ws of now) {
    const refused = was.has(ws) ? null : await watchIn(user, f.origin.path, ws);
    if (refused) return c.json({ error: refused }, 400);
  }
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    if (!st.folders.some((x) => x.id === id) || clash(st.folders)) return null;
    st.folders = moved(st.folders);
    await writeStorage(user, st);
    return st;
  });
  if (!out) return c.json({ error: "Not found" }, 404);
  await unwatch(user, f.origin.path, was, now);
  return c.json(shown(out, here, user, named));
});

/** Forget a folder, whatever workspace it is in (its marker files stay where they are). */
storageApp.delete("/folders/:id", async (c) => {
  const u = c.get("user");
  const user = u.username;
  const id = c.req.param("id");
  const { mine: here, named } = await scopeOf(c);
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    const gone = st.folders.find((f) => f.id === id);
    if (!gone) return null;
    const before = st.folders;
    st.folders = st.folders.filter((f) => f !== gone);
    await writeStorage(user, st);
    return { st, gone, before };
  });
  if (!out) return c.json({ error: "Not found" }, 404);
  // another workspace may read the same folder: its Library keeps it on the watch list
  if (out.gone.role !== "library" && out.gone.role !== "finals" && readHere(user, out.gone.origin.host)) {
    const of = await projectOf(u);
    await unwatch(user, out.gone.origin.path, await readersOf(user, of, out.before, out.gone.origin), await readersOf(user, of, out.st.folders, out.gone.origin));
  }
  return c.json(shown(out.st, here, user, named));
});
