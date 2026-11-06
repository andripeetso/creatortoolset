/**
 * Client for the workspace (api/workspace.ts) and invite links (api/auth.ts /invite): Settings → Workspace and the
 * /join/<token> page. Shapes: contracts/workspaces.ts.
 */
import type { Invite, InviteInfo, InviteInput, MemberPatch, WorkspaceView } from "@contracts/workspaces";

async function json<T>(res: Response): Promise<T> {
  const j = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new Error(j?.error || `Request failed (${res.status})`);
  return j as T;
}

const send = (url: string, method: string, body?: unknown) =>
  fetch(url, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export const getWorkspace = () => fetch("/api/workspace").then((r) => json<WorkspaceView | null>(r));
export const renameWorkspace = (name: string) => send("/api/workspace", "PATCH", { name }).then((r) => json<WorkspaceView>(r));
export const createInvite = (input: InviteInput) => send("/api/workspace/invites", "POST", input).then((r) => json<{ invite: Invite; token: string }>(r));
export const revokeInvite = (id: string) => send(`/api/workspace/invites/${id}`, "DELETE").then((r) => json<{ ok: true }>(r));
export const updateMember = (username: string, patch: MemberPatch) =>
  send(`/api/workspace/members/${encodeURIComponent(username)}`, "PATCH", patch).then((r) => json<WorkspaceView>(r));
export const removeMember = (username: string) =>
  send(`/api/workspace/members/${encodeURIComponent(username)}`, "DELETE").then((r) => json<WorkspaceView>(r));

export const inviteInfo = (token: string) => fetch(`/api/auth/invite/${token}`).then((r) => json<InviteInfo>(r));
/** Join: signed in = as that account (no body); else a new account. */
export const joinWithInvite = (token: string, account?: { username: string; password: string }) =>
  send(`/api/auth/invite/${token}`, "POST", account ?? {}).then((r) => json<{ ok: true; username: string }>(r));

export const inviteUrl = (token: string) => `${window.location.origin}/join/${token}`;

/** An invite link's path: /join/<token>. */
export const joinToken = (pathname: string): string | null => /^\/join\/([a-f0-9]{40})\/?$/.exec(pathname)?.[1] ?? null;
