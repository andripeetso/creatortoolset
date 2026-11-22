import type { JobId } from "./providers";
import type { PluginGateId, Tool } from "./tools";

/**
 * Teams (workspaces): an owner and members, invite links and each member's AI. A Server or Creator Toolset Cloud only
 * (api/lib/env.ts hasTeam; api/boot.ts mounts /api/workspace there, so on This Mac none of this exists).
 *
 * An account is a person; a workspace is a team. The account's role in `users.json` (admin) is the platform operator
 * who runs the server; a workspace role is what that person may do inside the team.
 *
 * AI for a member: never the owner's Claude or ChatGPT login. A member's AI is their own provider on their own Mac
 * (`own`), or a monthly budget on the workspace's API key (`budget`).
 *
 * Contract (Settings → Team; api/workspace.ts mounted at /api/workspace):
 *   GET    /api/workspace                      → WorkspaceView | null (no workspace)
 *   PATCH  /api/workspace                      { name?, signInWith?, budgetUsd?, aiTools? } (owner; null clears a
 *                                               limit) → WorkspaceView
 *   POST   /api/workspace/invites              InviteInput (owner) → { invite, token } (token shown once; with `email`
 *                                               the link is also emailed, api/lib/mail.ts)
 *   PATCH  /api/workspace/invites/:id          InvitePatch (owner) → WorkspaceView: what the person gets once they join
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
  /** the owner's workspaces (brands) this member works in: in the workspace switcher, and the owner's things there open read-only */
  workspaces?: string[];
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
  /** dollars a month the whole team may spend on the server's AI key; unset = no team limit, 0 = none at all */
  budgetUsd?: number;
  /** the tools that may run on the server's AI key (TEAM_AI_TOOLS); unset = all of them */
  aiTools?: JobId[];
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
  /** where the link was emailed, when it was */
  email?: string;
  /** set before they join, given to the account when they do: apps and plug-in gates off, and reading the owner's scripts */
  off?: (Tool | PluginGateId)[];
  /** apps they open but don't change (Read in the Access grid) */
  read?: Tool[];
  scripts?: boolean;
  /** the owner's workspaces they get (Member.workspaces) */
  workspaces?: string[];
}

export type InvitePatch = Partial<Pick<Invite, "off" | "read" | "scripts" | "workspaces">>;

export type InviteInput = Pick<Invite, "ai" | "budgetUsd" | "email" | "workspaces">;
/** `off`: apps and plug-in gates switched off for the member's account; a platform admin switches a plug-in's gates. */
export type MemberPatch = Partial<Pick<Member, "ai" | "budgetUsd" | "scripts" | "workspaces">> & { off?: (Tool | PluginGateId)[]; read?: Tool[] };

export interface MemberView extends Member {
  /** the account's display name (Settings → Account), read from the account: unset when it has none */
  name?: string;
  /** API spend this calendar month (UTC), dollars */
  spentUsd: number;
  lastActiveAt: number;
  /** apps and plug-in gates switched off for the account */
  off: (Tool | PluginGateId)[];
  /** apps the account opens but doesn't change */
  read?: Tool[];
}

export interface WorkspaceView {
  workspace: Pick<Workspace, "id" | "name" | "plan" | "comped" | "createdAt" | "signInWith" | "budgetUsd" | "aiTools">;
  /** the owner only: what the whole team spent on the server's AI key this month (UTC), dollars */
  spentUsd?: number;
  me: WorkspaceRole;
  /** the owner sees everything; a member sees names and roles, and their own row in full */
  members: MemberView[];
  /** the owner only */
  invites: Invite[];
  /** seats in use: everyone but the owner */
  seats: number;
  /** the server can email invites (RESEND_API_KEY and MAIL_FROM set): the owner only */
  mail?: boolean;
  /** the owner's own workspaces (brands), to give members: the owner only */
  brands?: { id: string; name: string }[];
}

export interface InviteInfo {
  /** the team's name */
  workspace: string;
  /** what the invite is for: the owner's workspaces it gives, by name, else the server's host (`server`) */
  target: string;
  /** the server they join (its host) */
  server: string;
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

/**
 * What deleting a workspace (the brand, a Workshop project: DELETE /api/workshop/projects/:id) deletes with it, from
 * GET /api/workshop/projects/:id/contents (api/lib/workspace-delete.ts): each kind that has any ("5 chats"), and
 * whether the person's own folders or Media Library files are in it (the files stay, only the app's records go).
 */
export interface WorkspaceContents {
  items: Array<{ n: number; what: string }>;
  ownFiles: boolean;
}

/** The tools a team's budget may run on the server's key. Never the Content Workshop: it needs a member's own AI provider. */
export const TEAM_AI_TOOLS: readonly Exclude<JobId, "workshop">[] = ["captions", "analyzer", "notes", "editor", "library"];
