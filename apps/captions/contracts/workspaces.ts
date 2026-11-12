import type { PluginGateId, Tool } from "./tools";

/**
 * Teams (workspaces): an owner and members, invite links and each member's AI. Hosted mode only (CT_MODE=hosted;
 * api/boot.ts mounts /api/workspace there, so on one person's Mac none of this exists).
 *
 * An account is a person; a workspace is a team. The account's role in `users.json` (admin) is the platform operator
 * who runs the server; a workspace role is what that person may do inside the team.
 *
 * AI for a member: never the owner's Claude or ChatGPT login. A member's AI is their own provider on their own Mac
 * (`own`), or a monthly budget on the workspace's API key (`budget`).
 *
 * Contract (Settings → Team; api/workspace.ts mounted at /api/workspace):
 *   GET    /api/workspace                      → WorkspaceView | null (no workspace)
 *   PATCH  /api/workspace                      { name } (owner) → WorkspaceView
 *   POST   /api/workspace/invites              InviteInput (owner) → { invite, token } (token shown once)
 *   DELETE /api/workspace/invites/:id          (owner)
 *   PATCH  /api/workspace/members/:username    MemberPatch (owner) → WorkspaceView
 *   DELETE /api/workspace/members/:username    (owner; the owner can't be removed)
 * Joining (api/auth.ts, hosted mode only):
 *   GET    /api/auth/invite/:token             → InviteInfo
 *   POST   /api/auth/invite/:token             { username, password } new account, or {} signed in → { ok, username }
 */

/** Owner or member, nothing between: the owner manages the team; what a member may open is set per member. */
export type WorkspaceRole = "owner" | "member";
export type AiRoute = "own" | "budget";

export interface Member {
  username: string;
  role: WorkspaceRole;
  ai: AiRoute;
  /** `budget`: dollars a month on the workspace's API key */
  budgetUsd: number;
  /** the owner lets this member read the owner's Workshop scripts (read-only); missing = no */
  scripts?: boolean;
  joinedAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  /** "team" = members and roles; "free" = the owner alone (billing: not built) */
  plan: "free" | "team";
  /** paid by the company that runs the server (the owner's own workspace) */
  comped: boolean;
  /** Settings → Team: everyone signs in with one of these instead of a password; unset or empty = any way */
  signInWith?: ("google" | "apple" | "github")[];
  members: Member[];
  createdAt: number;
}

export interface Invite {
  id: string;
  workspaceId: string;
  ai: AiRoute;
  budgetUsd: number;
  createdBy: string;
  createdAt: number;
  expiresAt: number;
}

export type InviteInput = Pick<Invite, "ai" | "budgetUsd">;
/** `off`: apps and plug-in gates switched off for the member's account; a platform admin switches a plug-in's gates. */
export type MemberPatch = Partial<Pick<Member, "ai" | "budgetUsd" | "scripts">> & { off?: (Tool | PluginGateId)[] };

export interface MemberView extends Member {
  /** the account's display name (Settings → Account), read from the account: unset when it has none */
  name?: string;
  /** API spend this calendar month (UTC), dollars */
  spentUsd: number;
  lastActiveAt: number;
  /** apps and plug-in gates switched off for the account */
  off: (Tool | PluginGateId)[];
}

export interface WorkspaceView {
  workspace: Pick<Workspace, "id" | "name" | "plan" | "comped" | "createdAt" | "signInWith">;
  me: WorkspaceRole;
  /** the owner sees everything; a member sees names and roles, and their own row in full */
  members: MemberView[];
  /** the owner only */
  invites: Invite[];
  /** seats in use: everyone but the owner */
  seats: number;
}

export interface InviteInfo {
  workspace: string;
  invitedBy: string;
  expired: boolean;
  /** the account already signed in on this browser, if any */
  signedInAs: string | null;
  /** already a member: nothing to accept */
  member: boolean;
}

/** An invite link lives this long. */
export const INVITE_DAYS = 7;
/** Invite tokens in links: /join/<token>. */
export const INVITE_TOKEN_RE = /^[a-f0-9]{40}$/;
