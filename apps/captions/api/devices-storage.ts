import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EVERY_WORKSPACE, EXPORTS_NAME, PROJECTS_NAME, libraryBase, STORAGE_ROLES, STORAGE_SCHEMA, THIS_COMPUTER, exportsOf, folderIn, okFolderPath, type StorageFolder, type StorageState, type StorageView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import type { ActionNeeded } from "../contracts/library";
import { deviceOf, isThisMachine, listDevices } from "./lib/devices";
import { env, hostedMode } from "./lib/env";
import { addWatchFolder, removeWatchFolder, watchAllowed } from "./library/watch";
import { inside, localDisks, mediaFolders, migrateStorage, mountOf, onInternalDisk, parseStorageFile, storageFilePath, withMounts } from "./lib/storage";
import { mergeStudio, replacedIds, studioRows, type HostLookup } from "./lib/studio-folders";
import { resolveDevice } from "./library/whereis";
import { keptApp } from "./kept";
import { libraryDb } from "./library/db";
import { repointFolders } from "./library/place-rows";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { inProjectOf, projectOf } from "./lib/project-of";
import { ownedProjects, sharedProjects } from "./lib/workshop/workspace";
import { ensureLibrary } from "./library/access";

/**
 * Settings → Folders (contracts/storage.ts), mounted at /api/devices/storage by devices.ts:
 *   GET    /                        → StorageView (this account's folders, and the server's own disks when CT_LOCAL=1);
 *                                     ?all=1: every workspace's folders
 *   POST   /folders   {role, host, path} → use a folder as a Media folder (role "footage"; this computer's also go on the
 *                                          Library's watch list), as the workspace's Projects folder (role "projects": in
 *                                          place of the one it had), or as its Exports folder (role "library": exactly that
 *                                          folder, made when missing). Finals reads Exports; "finals" is refused.
 *   PATCH  /folders/:id {workspaces} → the workspaces a Media or Exports folder is in; null = every workspace
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

/**
 * No file yet, or a file that is not valid JSON: an empty list (parseStorageFile logs the bad one). A file from before
 * schema 2 is moved on read (lib/storage.ts migrateStorage) and written back in the account's queue.
 */
async function readStorage(user: string): Promise<StorageState> {
  const raw = await readFile(file(user), "utf-8").catch(() => "{}");
  const parsed = parseStorageFile(raw);
  // nothing to migrate: the first folder saved onto it is written as the current schema, so no read rewrites it later
  if (!parsed.folders.length) return { ...parsed, schemaVersion: STORAGE_SCHEMA };
  const here = listDevices((d) => d.owner === user && isThisMachine(d.id))[0]?.id;
  const { st, changed } = migrateStorage(parsed, here, resolveDevice);
  if (changed) void chained(user, async () => {
    const now = parseStorageFile(await readFile(file(user), "utf-8").catch(() => "{}"));
    const again = migrateStorage(now, here, resolveDevice);
    if (again.changed) await writeStorage(user, again.st);
  }).catch((e: unknown) => console.warn(`[devices-storage] schema 2 not saved: ${e instanceof Error ? e.message : e}`));
  return st;
}

/**
 * The account's folders, as every reader gets them (report.ts, the relay's folder list, the assistant, the AI Editor's
 * heartbeat). One list: the Settings → Folders list (contracts/storage.ts). There is no second list, and no hostname is
 * mapped to a device id here (the one-time import, importStudioFile, is the only place that happens).
 */
export async function storageOf(user: string): Promise<StorageState> {
  return readStorage(user);
}

/** The one-time import of the plug-in's Settings → Folders list (`file`, storage.json, keyed by hostname) into the accounts'
 *  lists. A computer no account has is kept under its hostname (the page says "Computer not found"). Each row in both lists
 *  once; the file is renamed storage.json.migrated after the lists are written, so a second run finds nothing to do.
 *  `prepare` reads the file's own format (the plug-in's older entries). Returns the rows imported. */
export async function importStudioFile(file: string, fallbackOwner: string, prepare: (st: StorageState) => StorageState, lookup: HostLookup = lookupHost): Promise<number> {
  const raw = await readFile(file, "utf-8").catch(() => null);
  if (raw === null) return 0;
  const studio = prepare(parseStorageFile(raw));
  const byOwner = studioRows(studio.folders, lookup, fallbackOwner);
  for (const [owner, rows] of byOwner) {
    await chained(owner, async () => {
      const st = await readStorage(owner);
      const before = st.folders;
      st.folders = mergeStudio(before, rows);
      await writeStorage(owner, st);
      // a row merged into the studio's: its files' place rows are that folder's now
      repointFolders(replacedIds(before, st.folders));
    });
  }
  await rename(file, `${file}.migrated`);
  return studio.folders.length;
}

/** A hostname's computer on any account but the team's AI worker's: the one seen last (the import's lookup). */
function lookupHost(host: string): { id: string; owner: string } | undefined {
  const short = (x: string) => x.toLowerCase().replace(/\.local$/, "");
  const h = short(host);
  const d = listDevices((x) => x.owner !== "workspace" && !!x.report?.machine?.host && short(x.report.machine.host) === h)
    .sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
  return d ? { id: d.id, owner: d.owner } : undefined;
}

/**
 * The workspace's Projects or Exports folder for work on computer `device` (AI Editor working files; finished videos):
 * the one it has, else one made next to its first Media folder on that computer, written as a record. Never on the
 * Mac's internal disk by itself: with no Media folder off it, the answer says what to choose (Settings → Folders), and
 * for a named workspace's Projects folder it is a pause (`wait`): the chat's card offers the workspace's default
 * (~/Movies/Creator Toolset/<workspace>/Project files) or Choose…, and the job goes on once the row is there.
 */
export async function ensureUseFolder(user: string, workspace: string | undefined, role: "projects" | "library", device: string): Promise<StorageFolder | { error: string } | { wait: Extract<ActionNeeded, { kind: "projects" }> }> {
  // no workspace named: the account's only workspace; with several, the answer says what to choose. With none, only the
  // folders that have no workspace are its own: a workspace's folder is another client's, never picked
  const owned = workspace ? [] : await ownedProjects(user);
  if (!workspace && owned.length > 1) return { error: "Choose a Project files folder in Settings → Media Library." };
  const ws = workspace ?? owned[0]?.id;
  const inWs = (w?: string) => w === ws;
  const st = await readStorage(user);
  const has = st.folders.find((f) => f.role === role && f.origin.host === device && folderIn(f, inWs));
  if (has) return has;
  const media = st.folders.find((f) => f.role === "footage" && f.origin.host === device && folderIn(f, inWs));
  const disks = deviceOf(device)?.report?.machine?.disks ?? [];
  const parent = media ? media.origin.path.replace(/\/[^/]*$/, "") : "";
  const p = `${parent}/${role === "projects" ? PROJECTS_NAME : EXPORTS_NAME}`;
  // shortcut: a Media folder at a volume's root has no room beside it on that volume (its parent is /Volumes), so it is refused
  if (!media || !parent || /^\/(Volumes|media|mnt|run\/media)$/.test(parent) || onInternalDisk(p, disks)) {
    // a pause needs a workspace to name and a computer of the account's to make the folder on (the card's request)
    if (role !== "projects" || !ws || !deviceOf(device)) return { error: "Choose a Project files folder in Settings → Media Library." };
    const name = (await ownedProjects(user)).find((x) => x.id === ws)?.name || ws;
    return { wait: { kind: "projects", workspace: ws, workspaceName: name, device, path: `${libraryBase(name)}/${PROJECTS_NAME}` } };
  }
  return chained(user, async () => {
    const cur = await readStorage(user);
    const had = cur.folders.find((f) => f.role === role && f.origin.host === device && f.origin.path === p && folderIn(f, inWs));
    if (had) return had;
    const f: StorageFolder = { id: randomUUID(), role, name: p.split("/").pop() ?? p, origin: { host: device, path: p }, make: true, createdAt: Date.now(), reach: {}, ...(ws ? { workspace: ws } : {}) };
    cur.folders.push(f);
    await writeStorage(user, cur);
    return f;
  });
}

/**
 * Changes one folder in the account's list, in its queue (a location agent's report writes the folder's state there).
 * `fn` gets the folder and gives it back changed, or null for no change. False when there is no such folder.
 */
export function updateFolder(user: string, id: string, fn: (f: StorageFolder) => StorageFolder | null): Promise<boolean> {
  return chained(user, async () => {
    const st = await readStorage(user);
    const i = st.folders.findIndex((f) => f.id === id);
    if (i < 0) return false;
    const next = fn(st.folders[i]!);
    if (!next) return true;
    st.folders[i] = next;
    await writeStorage(user, st);
    return true;
  });
}

/** Changes an account's list as one queued write (a plug-in's Settings → Folders routes use it): `fn` edits the list in place. */
export function changeStorage(user: string, fn: (st: StorageState) => void | "keep"): Promise<StorageState> {
  return chained(user, async () => {
    const st = await readStorage(user);
    if (fn(st) === "keep") return st;
    await writeStorage(user, st);
    return st;
  });
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
/**
 * Exports is one folder per workspace: the workspaces folder `keep` is given (`to`, null = every workspace) come off every
 * other Exports folder, and one left with none is forgotten (its files stay). One for every workspace stays when another is
 * given only some: a workspace's own comes first (contracts/storage.ts exportsOf).
 */
export function exportsTakeOver(folders: StorageFolder[], keep: string, to: string[] | null, of: (own?: string) => string): StorageFolder[] {
  return folders.flatMap((x) => {
    if (x.id === keep || x.role !== "library") return [x];
    const had = placesOf(x, of);
    if (!had) return to ? [x] : [];
    if (!to) return [x];
    const left = had.filter((w) => !to.includes(w));
    return left.length === had.length ? [x] : left.length ? [placedIn(x, left)] : [];
  });
}

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
 * A folder on any other computer (a Mac, a helper) is read only by that computer's location agent: its report
 * (library/report.ts applyReport) writes the place rows whereIs reads. The server never opens that path, never watches it.
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
const shown = (st: StorageState, mine: (f: StorageFolder) => boolean, user: string, named: Named): StorageState => {
  const ours = new Set(listDevices((d) => d.owner === user).map((d) => d.id).concat(THIS_COMPUTER));
  return {
    ...st,
    folders: withMounts(st.folders.filter(mine), listDevices((d) => d.owner === user).map((d) => ({ id: d.id, disks: d.report?.machine?.disks }))).map((f) => {
      const workspace = named(f);
      const row = workspace ? { ...f, workspace } : f;
      // a folder whose computer is none of the account's: listed, and the page says so
      return ours.has(f.origin.host) ? row : { ...row, missing: true as const };
    }),
  };
};

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
  const lib = exportsOf(st.folders);
  const reported = lib ? deviceOf(lib.origin.host)?.report?.machine?.disks ?? [] : [];
  const libraryPath = lib && !reported.length ? lib.origin.path : undefined;
  const local = process.env.CT_LOCAL === "1" && u.role === "admin";
  // which of this account's computers is this machine: a folder added on it goes into the Library (the page asks first when it is big)
  const here = watchAllowed(u.username) ? listDevices((d) => !!mine(c, d.id) && isThisMachine(d.id)).map((d) => d.id) : [];
  const view: StorageView = { ...st, serverDisks: local ? await localDisks(libraryPath) : [], here, copies: keepsCopies(scope.workspace ?? u.username), ...(all ? { copied: await copiedFolders(u, st.folders) } : {}) };
  return c.json(view);
});

/** Use a folder you already have as a Media folder, or a folder as the workspace's Finals or Exports folder. */
storageApp.post("/folders", async (c) => {
  const u = c.get("user");
  const user = u.username;
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  // "music" from an older app is footage: the Media Library sorts songs and sound effects itself
  // the three uses (Media, Projects, Exports); "music" from an older app is footage; "finals" is no use any more (Finals reads Exports)
  const role: "footage" | "library" | "projects" | undefined = b?.role === "music" ? "footage" : b?.role === "footage" || b?.role === "library" || b?.role === "projects" ? b.role : undefined;
  // "this computer" (setup's Folders step) is the paired computer this server runs on, when there is one (schema 2)
  const asked = str(b?.host, 120);
  const host = asked === THIS_COMPUTER ? (listDevices((d) => d.owner === user && isThisMachine(d.id))[0]?.id ?? asked) : asked;
  const raw = b?.path;
  if (!role || !host || !okFolderPath(raw) || !(thisComputer(c, host) || mine(c, host))) return c.json({ error: "Needs a computer and a folder" }, 400);
  // "~/…" on this computer is its home folder: stored as the full path, so it matches the scan's list; another computer's stays "~/…"
  const local = asked === THIS_COMPUTER || isThisMachine(host);
  const p = (local && (raw === "~" || raw.startsWith("~/")) ? path.join(os.homedir(), raw.slice(1)) : raw).replace(/(.)\/+$/, "$1");
  const [{ mine: here, workspace, named }, of] = await Promise.all([scopeOf(c), projectOf(u)]);
  // a folder inside one of this workspace's Media folders is in the Media Library already
  const outer = role === "footage" && (await readStorage(user)).folders.find((f) => here(f) && f.role === "footage" && f.origin.host === host && !!inside(p, f.origin.path));
  if (outer) return c.json({ error: `That folder is already in ${outer.name}` }, 400);
  // setup's scratch default is made here, before its row is checked; only under ~/Movies/Creator Toolset on this computer
  if (role === "footage" && b?.make === true && local && !!inside(p, path.join(os.homedir(), "Movies", "Creator Toolset"))) {
    try {
      await mkdir(p, { recursive: true });
    } catch {
      return c.json({ error: "That folder could not be made on this computer" }, 400);
    }
  }
  // this computer's folders are read by the Library and the AI Editor through its watch list: the path is checked there.
  // A Finals folder is not footage: only its projects' subfolders are read, into Finals (library/watch.ts watchFinals)
  if (role === "footage" && (asked === THIS_COMPUTER || readHere(user, host))) {
    const refused = await addWatchFolder(user, p);
    if (refused) return c.json({ error: refused }, 400);
  }
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    if (st.folders.some((f) => here(f) && f.role === role && f.origin.host === host && f.origin.path === p)) return null;
    // one Projects folder per workspace: the one it had is replaced (its files stay)
    if (role === "projects") st.folders = st.folders.filter((f) => !(here(f) && f.role === "projects"));
    // the workspace's Exports comes off the folder that had it; with no workspaces there is one Exports folder
    if (role === "library") {
      // one folder is one Exports record (one marker): another workspace's folder picked here gets this workspace too
      const had = workspace && of && st.folders.find((f) => f.role === "library" && f.origin.host === host && f.origin.path === p);
      const places = had && placesOf(had, of);
      if (had && places) {
        st.folders = exportsTakeOver(st.folders.map((f) => (f === had ? placedIn(f, [...places, workspace]) : f)), had.id, [workspace], of);
        await writeStorage(user, st);
        return st;
      }
      st.folders = workspace && of ? exportsTakeOver(st.folders, "", [workspace], of) : st.folders.filter((f) => f.role !== "library");
    }
    // the share its drive is on that computer, so another computer can be told how to connect it (never a password)
    const mount = mountOf(p, deviceOf(host)?.report?.machine?.disks);
    // an Exports folder is made when missing (setup's default may not be there yet); the others must already exist
    st.folders.push({ id: randomUUID(), role, name: p.split("/").filter(Boolean).pop() ?? p, origin: { host, path: p }, make: role !== "footage", createdAt: Date.now(), reach: {}, ...(workspace ? { workspace } : {}), ...(mount ? { mount } : {}) });
    await writeStorage(user, st);
    return st;
  });
  return out ? c.json(shown(out, here, user, named)) : c.json({ error: "That folder is already there" }, 400);
});

/**
 * Which of the account's workspaces a Media or Exports folder is in: `workspaces`, one or more, or null for every
 * workspace (`workspace`, one id or null, from before). An Exports folder takes them off the one that had them (exportsTakeOver).
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
  if (f.role === "finals") return c.json({ error: "Finals is one folder per workspace" }, 400);
  const moved = (list: StorageFolder[]) => {
    const out = list.map((x) => (x.id === id ? placedIn(x, to) : x));
    return f.role === "library" ? exportsTakeOver(out, id, to, of) : out;
  };
  const clash = (list: StorageFolder[]) =>
    list.some((x) => {
      if (x.id === id || x.role !== f.role || x.origin.host !== f.origin.host || x.origin.path !== f.origin.path) return false;
      const in_ = placesOf(x, of);
      return !to || !in_ || in_.some((w) => to.includes(w));
    });
  if (clash(before)) return c.json({ error: "That folder is already there" }, 400);
  const watched = f.role === "footage" && readHere(user, f.origin.host);
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

/**
 * POST /api/devices/storage/folders/:id/re-point {path}: the folder moved or was renamed on its computer, and the person
 * picked where it is now (the Mac's folder picker). Same computer, new path; its state there is cleared ("Not checked
 * yet") and its place rows turn unchecked until that computer's next report lists it. A folder this server reads itself
 * moves on the watch list too. Returns the folder list like the other routes here.
 */
storageApp.post("/folders/:id/re-point", async (c) => {
  const u = c.get("user");
  const user = u.username;
  const id = c.req.param("id");
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const raw = b?.path;
  // the folder's own computer's path, whole ("~" is a home folder this server cannot say for another computer)
  if (!okFolderPath(raw) || raw.startsWith("~")) return c.json({ error: "Needs a folder" }, 400);
  const p = raw.normalize("NFC").replace(/(.)\/+$/, "$1");
  const { mine: here, named } = await scopeOf(c);
  const before = (await readStorage(user)).folders;
  const f = before.find((x) => x.id === id);
  if (!f) return c.json({ error: "Not found" }, 404);
  if (f.origin.path === p) return c.json(shown({ folders: before }, here, user, named));
  if (before.some((x) => x.id !== id && x.role === f.role && x.origin.host === f.origin.host && x.origin.path === p)) return c.json({ error: "That folder is already there" }, 400);
  const watched = f.role !== "library" && f.role !== "finals" && readHere(user, f.origin.host);
  const of = watched ? await projectOf(u) : null;
  const was = watched ? await readersOf(user, of, before, f.origin) : new Set<string>();
  for (const ws of was) {
    const refused = await watchIn(user, p, ws);
    if (refused) return c.json({ error: refused }, 400);
  }
  const out = await chained(user, async () => {
    const st = await readStorage(user);
    const i = st.folders.findIndex((x) => x.id === id);
    if (i < 0) return null;
    // its state there and a container path were the old path's
    const { folderState: _s, checkedAt: _c, mountPath: _m, ...rest } = st.folders[i]!;
    st.folders[i] = { ...rest, name: p.split("/").filter(Boolean).pop() ?? p, origin: { ...rest.origin, path: p } };
    await writeStorage(user, st);
    return st;
  });
  if (!out) return c.json({ error: "Not found" }, 404);
  libraryDb().prepare("UPDATE version_places SET state = 'unchecked' WHERE device = ? AND folder_id = ? AND state <> 'unchecked'").run(f.origin.host, id);
  if (watched) await unwatch(user, f.origin.path, was, await readersOf(user, of, out.folders, f.origin));
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
