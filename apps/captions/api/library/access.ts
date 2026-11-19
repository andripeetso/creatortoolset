import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";
import { pluginMainSource, pluginUploadsTo } from "../lib/plugin";
import { announce } from "../lib/sync";
import { inProjectOf } from "../lib/project-of";
import { sharedHere, sharedProjects, workspaceScope } from "../lib/workshop/workspace";
import { currentWorkspaceId, inCurrentWorkspace } from "../lib/workspace-scope";
import { findUser, listUsers, LOCAL_USER, mayChange, mayUse, type SessionUser } from "../users";
import { blobs, libraryDb, newLibrarySettings } from "./db";
import { workspaceById } from "../lib/workspaces";
import { actionCard, quickSetup, type ActionNeeded } from "../../contracts/library";
import type { LibrarySource } from "../../contracts/library-source";
import { libraryBase, THIS_COMPUTER } from "../../contracts/storage";
import { isOnline, listDevices } from "../lib/devices";
import { assetRef, canSee, mainSource } from "./sources";

let before: Record<string, string> | null = null;
/**
 * The id an account's libraries (libraries.workspace_id) and AI Editor edits (workspaceId) carry: its username. An
 * install from before keeps the id it already had: the one in $DATA_DIR/workspaces.json it owned (read once).
 */
export function homeOf(username: string): string {
  if (!before) {
    before = {};
    try {
      const s = JSON.parse(readFileSync(path.join(env.dataDir, "workspaces.json"), "utf-8")) as { workspaces?: { id: string; members: { username: string; role: string }[] }[] };
      for (const w of s.workspaces ?? []) for (const m of w.members) if (m.role === "owner") before[m.username] ??= w.id;
    } catch {
      /* a fresh install */
    }
  }
  return before[username] ?? username;
}

/**
 * Tells the library's account that it changed, for a save outside a request (the worker, a watch folder): its open
 * Media Library and Finals pages refetch (api/lib/sync.ts). A request's own write is announced already.
 */
export function libraryChanged(libraryId: string): void {
  const row = libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as { workspace_id: string } | undefined;
  if (!row) return;
  announce(accountOf(row.workspace_id) ?? row.workspace_id, "library");
}

/** The account whose libraries and AI Editor edits carry this id (homeOf), or null. */
export function accountOf(workspaceId: string): string | null {
  return [...listUsers().map((u) => u.username), LOCAL_USER.username].find((u) => homeOf(u) === workspaceId) ?? null;
}

/** Which of the account's libraries are in a workspace: `projectId`, else the one this request works in (inProjectOf). */
const scopeOf = (username: string, projectId?: string) => {
  const user = { username } as SessionUser;
  return projectId === undefined ? inCurrentWorkspace(user) : inProjectOf(user, projectId);
};

type LibraryRow = { id: string; name: string; storage_kind: string; settings: string };

function librariesIn(username: string, keep: ((own?: string) => boolean) | null): LibraryRow[] {
  const rows = libraryDb()
    .prepare("SELECT id, name, storage_kind, settings, json_extract(settings, '$.projectId') AS ws FROM libraries WHERE workspace_id = ? ORDER BY created_at, id")
    .all(homeOf(username)) as (LibraryRow & { ws: string | null })[];
  return rows.filter((r) => !keep || keep(r.ws ?? undefined));
}

/**
 * The account's libraries in one workspace, oldest first: `projectId`, else the one this request works in. A library is
 * a workspace's by its settings.projectId; one from before workspaces is the first brand's (project-of.ts). Every one of
 * the account's for a person with no workspace, or a `projectId` that is not theirs ("" too).
 */
export async function librariesHere(username: string, projectId?: string): Promise<LibraryRow[]> {
  // a workspace the team's owner gave this person (Settings → Team): the owner's libraries there, to look at (givenLibrary)
  const given = projectId === undefined ? await sharedHere({ username } as SessionUser) : null;
  if (given) return librariesIn(given.owner, await inProjectOf({ username: given.owner } as SessionUser, given.id));
  return librariesIn(username, await scopeOf(username, projectId));
}

/**
 * Whether the library is the team owner's, in a workspace the owner gave this account (Settings → Team → Access): it may
 * look at it and download from it, never change it (libraryRole stays null, and every write asks libraryRole).
 */
export async function givenLibrary(username: string, libraryId: string): Promise<boolean> {
  const account = findUser(username);
  if (account && !mayUse(account, "media")) return false;
  const row = libraryDb().prepare("SELECT workspace_id, json_extract(settings, '$.projectId') AS ws FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string; ws: string | null }
    | undefined;
  if (!row) return false;
  for (const p of await sharedProjects(username)) {
    if (homeOf(p.owner) === row.workspace_id && (await inProjectOf({ username: p.owner } as SessionUser, p.id))?.(row.ws ?? undefined)) return true;
  }
  return false;
}

/**
 * The workspace's own local library (`projectId`, else the one this request works in), made silently the first time
 * something needs one (Finals, the Home readiness, the Media Library): "Library". Its id, or null when the account may
 * not use the Media Library.
 */
export async function ensureLibrary(username: string, projectId?: string): Promise<string | null> {
  const account = findUser(username);
  if (account && !mayUse(account, "media")) return null;
  const [keep, ws] = await Promise.all([scopeOf(username, projectId), projectId ?? currentWorkspaceId({ username } as SessionUser)]);
  // nothing is awaited between the look and the insert: two pages asking at once never make two
  const found = librariesIn(username, keep)[0];
  if (found) return found.id;
  const id = `lib_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, settings, created_at) VALUES (?, ?, 'Library', 'local', ?, ?)")
    .run(id, homeOf(username), newLibrarySettings(keep && ws ? { projectId: ws } : {}), Date.now());
  return id;
}

/**
 * "owner" when the library is the account's own (homeOf), else null: a library of another account, or one that does
 * not exist, so callers answer 404, never 403. An account with the Media Library switched off is null too: the
 * Workshop, exports and plug-ins read the library through here, outside the /api/library tool gate (boot.ts).
 */
export function libraryRole(username: string, libraryId: string): "owner" | null {
  const account = findUser(username);
  if (account && !mayUse(account, "media")) return null;
  const row = libraryDb().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as
    | { workspace_id: string }
    | undefined;
  return row && row.workspace_id === homeOf(username) ? "owner" : null;
}

/**
 * Whether the account may add footage to the library: its own, or the owner's in a workspace the owner gave it with the
 * Media Library on Read & write (Settings → Team → Access). Adding only: changing or deleting what is there stays with
 * libraryRole (the owner), and a member's upload is marked as theirs (created_by).
 */
export async function mayAdd(user: SessionUser, libraryId: string): Promise<boolean> {
  return !!libraryRole(user.username, libraryId) || ((await givenLibrary(user.username, libraryId)) && mayChange(user, "media"));
}

/**
 * The workspace this request names (the app's X-CT-Workspace, or a chat's own, which wins: workspaceScope), checked:
 * undefined when it names none (an older app or phone, which goes on as before), null when it names one this account
 * can't see. That one is refused, never answered for another workspace.
 */
export async function askedWorkspace(user: SessionUser): Promise<string | null | undefined> {
  const asked = workspaceScope.getStore()?.id;
  if (!asked) return undefined;
  return (await currentWorkspaceId(user)) === asked ? asked : null;
}

/**
 * Whether this request may add footage to the library as far as workspaces go (owner, 2026-11-16: "Each workspace is its
 * own client"): a request that names a workspace adds only to that workspace's libraries, one that names none as before.
 * Who may add at all stays with mayAdd.
 */
export async function inAskedWorkspace(user: SessionUser, libraryId: string): Promise<boolean> {
  const asked = await askedWorkspace(user);
  if (asked === undefined) return true;
  return asked !== null && (await librariesHere(user.username)).some((l) => l.id === libraryId);
}

/**
 * Whether the account may change this version of the library: its library role, and the policies may see the asset
 * (sources.ts). Writes to assets, collection membership and pieces ask here, so a narrowing policy holds for writes too,
 * not only for reads. A share link's creation asks visibleCards instead (shares.ts).
 */
export async function mayWrite(username: string, libraryId: string, assetId: string, versionId: string): Promise<boolean> {
  const role = libraryRole(username, libraryId);
  return !!role && (await canSee({ username, role }, assetRef(libraryId, assetId, versionId)));
}

/**
 * A version's original as a local file, for an account that may still read its library, while the asset is out of the
 * trash. Null otherwise. Caption Studio reads a clip's source through this when the clip came from the library.
 */
export async function versionSource(username: string, versionId: string): Promise<string | null> {
  const v = libraryDb()
    .prepare("SELECT a.id AS asset_id, a.library_id, v.source_key FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.trashed_at IS NULL")
    .get(versionId) as { asset_id: string; library_id: string; source_key: string } | undefined;
  const role = v ? libraryRole(username, v.library_id) : null;
  if (!v || !role || !(await canSee({ username, role }, assetRef(v.library_id, v.asset_id, versionId)))) return null;
  return blobs.localCopy(v.source_key).catch(() => null);
}

/**
 * Whether a workspace's Media Library is set up (setupAt, on the library its owner keeps, found by the workspace's
 * projectId: never the asker's home). No projectId: the asker's own first library. `owner`: the asker sets it up; a
 * member is told it isn't set up, with no button.
 */
export async function mediaReady(username: string, projectId?: string): Promise<{ ready: boolean; owner: boolean; libraryId: string | null }> {
  const cols = "SELECT id, json_extract(settings, '$.setupAt') AS setupAt FROM libraries WHERE";
  const d = libraryDb();
  type Row = { id: string; setupAt: string | null };
  if (projectId === undefined) {
    const row = d.prepare(`${cols} workspace_id = ? ORDER BY created_at, id LIMIT 1`).get(homeOf(username)) as Row | undefined;
    return settled(row, true, username, undefined);
  }
  const ws = workspaceById(projectId);
  const owner = !!ws?.members.some((m) => m.username === username && m.role === "owner");
  const row =
    (d.prepare(`${cols} json_extract(settings, '$.projectId') = ? ORDER BY created_at, id LIMIT 1`).get(projectId) as Row | undefined) ??
    // a library from before workspaces kept their own: the first brand's, as librariesIn reads it
    (ws && (d.prepare(`${cols} workspace_id = ? AND json_extract(settings, '$.projectId') IS NULL ORDER BY created_at, id LIMIT 1`).get(homeOf(ws.members.find((m) => m.role === "owner")?.username ?? "")) as Row | undefined));
  return settled(row || undefined, owner, username, projectId);
}

/** A library not set up whose workspace a plug-in serves itself is set up now (setupAt written once, as the migration does). */
async function settled(row: { id: string; setupAt: string | null } | undefined, owner: boolean, username: string, projectId: string | undefined) {
  if (row?.setupAt) return { ready: true, owner, libraryId: row.id };
  if (!(await servedByPlugin(username, projectId))) return { ready: false, owner, libraryId: row?.id ?? null };
  if (row) libraryDb().prepare("UPDATE libraries SET settings = json_set(COALESCE(settings, '{}'), '$.setupAt', ?) WHERE id = ? AND json_extract(settings, '$.setupAt') IS NULL").run(new Date().toISOString(), row.id);
  return { ready: true, owner, libraryId: row?.id ?? null };
}

/**
 * Whether a loaded plug-in serves this workspace's media itself: its uploadsTo names its own store there (a footage
 * catalog), so the core library stays empty by design and needs no setup. A plug-in that refuses the question (no
 * workspace named) does not serve it.
 */
export async function servedByPlugin(username: string, projectId?: string): Promise<boolean> {
  const ask = () => pluginUploadsTo(username);
  try {
    return !!(await (projectId ? workspaceScope.run({ id: projectId }, ask) : ask()));
  } catch {
    return false;
  }
}

/**
 * The plug-in source that is this workspace's Media Library (LibrarySource.main): only in a workspace its plug-in serves
 * itself (its uploadsTo, as servedByPlugin asks), undefined in every other one, whose Media Library is its own. With no
 * workspace named: the request's, else the person's current one. A person with no workspace, or a plug-in that fails to
 * answer, gets the server-wide answer (mainSource).
 */
export async function mainSourceFor(username: string, projectId?: string): Promise<LibrarySource | undefined> {
  const scoped = workspaceScope.getStore()?.id;
  const id = projectId ?? scoped ?? (await currentWorkspaceId({ username } as SessionUser));
  if (!id) return mainSource();
  const ask = () => pluginMainSource(username);
  try {
    return await (id === scoped ? ask() : workspaceScope.run({ id }, ask));
  } catch {
    return mainSource();
  }
}

/** The chat card's setup ask for a workspace whose Media Library is not set up (ActionNeeded), or null when it is.
 *  Quick setup makes the folders on the asker's computer seen last (online first); on a server on the person's own
 *  computer with none paired, on that computer. No computer at all: the card says so. */
export async function setupNeeded(username: string, projectId?: string): Promise<ActionNeeded | null> {
  const m = await mediaReady(username, projectId);
  if (m.ready) return null;
  const ws = projectId === undefined ? undefined : workspaceById(projectId);
  const name = ws?.name ?? "";
  const libraryId = (m.owner && (m.libraryId ?? (await ensureLibrary(username, projectId)))) || m.libraryId || "";
  const d = listDevices((x) => x.owner === username).sort((a, b) => Number(isOnline(b.id)) - Number(isOnline(a.id)) || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))[0];
  const device = d?.id ?? ((await import("./watch")).watchAllowed(username) ? THIS_COMPUTER : null);
  return actionCard({
    kind: "setup", workspace: projectId ?? "", workspaceName: name, owner: m.owner, href: "/library?setup=1", libraryId, device,
    ...(d ? { deviceName: d.name } : device ? { deviceName: "this computer" } : {}),
    defaults: quickSetup(libraryBase(name || "Media Library")),
  });
}
