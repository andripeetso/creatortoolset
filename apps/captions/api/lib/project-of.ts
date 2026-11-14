import { mineAccountId } from "../instagram";
import type { SessionUser } from "../users";
import { ownedProjects } from "./workshop/workspace";

/**
 * A person's projects, and the one each of their things is in: the project it was made in, or, for a thing with no
 * project of its own (from before it had one, or its project is gone), the first brand's. That is the rule the
 * Workshop filed its own old records by (scopeOldRecords, workshop.ts): the project that links "my account", else
 * the oldest. null for a person with no project: nothing is kept apart then.
 */
async function projectsOf(user: SessionUser): Promise<{ of: (own?: string) => string; ids: Set<string> } | null> {
  const projects = await ownedProjects(user.username);
  if (!projects.length) return null;
  const mine = await mineAccountId(user).catch(() => undefined);
  const first = (projects.find((p) => mine && p.accountId === mine) ?? [...projects].sort((a, b) => a.createdAt - b.createdAt)[0])!.id;
  const ids = new Set(projects.map((p) => p.id));
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
