import type { SessionUser } from "../users";
import { mineAccountId } from "./instagram/accounts";
import { ownedProjects, sharedProjects } from "./workshop/workspace";

/**
 * A person's projects, and the one each of their things is in: the project it was made in, or, for a thing with no
 * project of its own (from before it had one, or its project is gone), the first brand's. That is the rule the
 * Workshop filed its own old records by (scopeOldRecords, workshop.ts): the project that links "my account", else
 * the oldest. null for a person with no project: nothing is kept apart then.
 */
async function projectsOf(user: SessionUser): Promise<{ of: (own?: string) => string; ids: Set<string> } | null> {
  const [own, shared] = await Promise.all([ownedProjects(user.username), sharedProjects(user.username)]);
  // a workspace given to them (Settings → Team) holds what they make there too; their unfiled things stay their own first brand's
  const projects = own.length ? own : shared;
  if (!projects.length) return null;
  // the stored accounts only (lib/instagram/accounts.ts): everything that keeps workspaces apart reaches this file, and
  // loading the whole Analyzer here took ~7 s on a busy test run (11-19)
  const mine = await mineAccountId(user).catch(() => undefined);
  const first = (projects.find((p) => mine && p.accountId === mine) ?? [...projects].sort((a, b) => a.createdAt - b.createdAt)[0])!.id;
  const ids = new Set([...own, ...shared].map((p) => p.id));
  return { of: (own) => (own && ids.has(own) ? own : first), ids };
}

/** The project each of the person's things is in, by the thing's own `projectId` (above); null with no project. */
export async function projectOf(user: SessionUser): Promise<((own?: string) => string) | null> {
  return (await projectsOf(user))?.of ?? null;
}

/**
 * Which of the person's things are in one of their projects, for a list asked for that project (a video edit, say).
 * null: no project of theirs by that id, so the whole list.
 */
export async function inProjectOf(user: SessionUser, projectId: string | undefined): Promise<((own?: string) => boolean) | null> {
  if (!projectId) return null;
  const p = await projectsOf(user);
  if (!p?.ids.has(projectId)) return null;
  return (own) => p.of(own) === projectId;
}

/**
 * Whether a thing of `owner`'s (by its own `projectId`) is in one of the workspaces the team's owner gave this account
 * (Settings → Team → Access): it may read it, never change it. Read fresh, so taking a workspace away holds at once.
 */
export async function sharedTo(user: SessionUser, owner: string, projectId?: string): Promise<boolean> {
  for (const p of await sharedProjects(user.username)) {
    if (p.owner === owner && (await inProjectOf({ username: owner } as SessionUser, p.id))?.(projectId)) return true;
  }
  return false;
}
