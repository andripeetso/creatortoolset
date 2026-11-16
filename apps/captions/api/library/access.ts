import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";
import { announce } from "../lib/sync";
import { inProjectOf } from "../lib/project-of";
import { sharedHere, sharedProjects } from "../lib/workshop/workspace";
import { currentWorkspaceId, inCurrentWorkspace } from "../lib/workspace-scope";
import { findUser, listUsers, LOCAL_USER, mayChange, mayUse, type SessionUser } from "../users";
import { blobs, libraryDb } from "./db";
import { assetRef, canSee } from "./sources";

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
  const accounts = [...listUsers().map((u) => u.username), LOCAL_USER.username];
  announce(accounts.find((u) => homeOf(u) === row.workspace_id) ?? row.workspace_id, "library");
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
    .run(id, homeOf(username), JSON.stringify(keep && ws ? { projectId: ws } : {}), Date.now());
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
  return !!libraryRole(user.username, libraryId) || (mayChange(user, "media") && (await givenLibrary(user.username, libraryId)));
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
