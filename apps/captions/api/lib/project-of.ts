import { mineAccountId } from "../instagram";
import type { SessionUser } from "../users";
import { ownedProjects } from "./workshop/workspace";

/**
 * Which of a person's things are in one of their projects, for a list asked for that project (a video edit, say): what
 * was made in it, and what has no project of its own (from before it had one, or its project is gone) when it is the
 * first brand's. That is the rule the Workshop filed its own old records by (scopeOldRecords, workshop.ts): the
 * project that links "my account", else the oldest. null: no project of theirs by that id, so the whole list.
 */
export async function inProjectOf(user: SessionUser, projectId: string | undefined): Promise<((own?: string) => boolean) | null> {
  if (!projectId) return null;
  const projects = await ownedProjects(user.username);
  if (!projects.some((p) => p.id === projectId)) return null;
  const mine = await mineAccountId(user).catch(() => undefined);
  const first = (projects.find((p) => mine && p.accountId === mine) ?? [...projects].sort((a, b) => a.createdAt - b.createdAt)[0])!.id;
  const ids = new Set(projects.map((p) => p.id));
  return (own) => (own && ids.has(own) ? own : first) === projectId;
}
