import { inProject } from "../workshop/workspace";

/** One Analyzer account per owner can be marked as theirs. */

export function nextMineFlags(
  accounts: Array<{ id: string; owner: string; mine?: boolean }>,
  owner: string,
  accountId: string | null,
): Array<{ id: string; mine: boolean }> {
  return accounts
    .filter((a) => a.owner === owner)
    .map((a) => ({ id: a.id, mine: a.id === accountId }))
    .filter((a) => a.mine !== Boolean(accounts.find((x) => x.id === a.id)?.mine));
}

type AccountRef = { id: string; username: string; mine?: boolean };
type PostRef = { projectId?: string; accountId?: string; creator?: { username?: string }; platform?: "youtube" };

export function accountOwnsPost(acc: AccountRef, post: PostRef): boolean {
  if (post.accountId === acc.id) return true;
  // a YouTube channel named like one of the author's Instagram accounts is not that account
  if (post.platform === "youtube") return false;
  const handle = post.creator?.username?.toLowerCase();
  return Boolean(handle && handle === acc.username.toLowerCase());
}

/** Own-account posts follow `mine` (the caller passes it only in its own project, projectScope in instagram.ts). Focused competitor lists stay project-scoped. */
export function postInProject(
  post: PostRef,
  projectId?: string | null,
  opts: { focus?: AccountRef | null; mine?: AccountRef | null } = {},
): boolean {
  const { focus, mine } = opts;
  if (focus) return accountOwnsPost(focus, post) && (!!focus.mine || inProject(post, projectId));
  if (mine && accountOwnsPost(mine, post)) return true;
  return inProject(post, projectId);
}
