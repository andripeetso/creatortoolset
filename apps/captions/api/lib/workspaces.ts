import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "./env";
import { INVITE_DAYS, type AiRoute, type Invite, type InviteInput, type Member, type Workspace, type WorkspaceRole } from "../../contracts/workspaces";
import { findUser, listUsers, LOCAL_USER } from "../users";

/**
 * Workspaces, members, invites and each member's API spend (contracts/workspaces.ts):
 * $DATA_DIR/workspaces.json { workspaces, invites (token sha256), spend { "<user>": { "<YYYY-MM>": usd } } }.
 *
 * First load on a server that has accounts but no file: one workspace from them, the first admin (ADMIN_USERNAME
 * first) its owner, everyone else a member on their own AI (`own`). Comped: it is the
 * server owner's own team. Settings from before (Admin → AI access `sharedWith`) are not carried over: a member
 * never runs on the owner's subscription (Anthropic's terms).
 */

const FILE = () => path.join(env.dataDir, "workspaces.json");
const DAY = 86_400_000;

interface StoredInvite extends Invite {
  tokenHash: string;
}

interface Store {
  workspaces: Workspace[];
  invites: StoredInvite[];
  spend: Record<string, Record<string, number>>;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);

function migrate(): Store {
  const accounts = listUsers().filter((u) => u.username !== "demo");
  const admins = accounts.filter((u) => u.role === "admin");
  if (!admins.length) return { workspaces: [], invites: [], spend: {} };
  const owner = admins.find((u) => u.username === env.adminUsername) ?? admins[0]!;
  const now = Date.now();
  const member = (username: string, role: WorkspaceRole): Member => ({ username, role, ai: "own", budgetUsd: 0, joinedAt: now });
  return {
    workspaces: [
      {
        id: randomUUID(),
        name: "Workspace",
        plan: "team",
        comped: true,
        createdAt: now,
        members: [
          member(owner.username, "owner"),
          ...accounts.filter((u) => u !== owner).map((u) => member(u.username, "member")),
        ],
      },
    ],
    invites: [],
    spend: {},
  };
}

function load(): Store {
  try {
    const s = JSON.parse(readFileSync(FILE(), "utf-8")) as Partial<Store>;
    return { workspaces: s.workspaces ?? [], invites: s.invites ?? [], spend: s.spend ?? {} };
  } catch {
    const s = migrate();
    if (s.workspaces.length) persist(s);
    return s;
  }
}

let writeChain: Promise<void> = Promise.resolve();
function persist(s: Store = store()): void {
  const json = JSON.stringify(s, null, 2);
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(env.dataDir, { recursive: true });
      const tmp = `${FILE()}.tmp-${process.pid}`;
      await writeFile(tmp, json);
      await rename(tmp, FILE());
    } catch (e) {
      console.error("[workspaces] failed to persist workspaces.json:", e);
    }
  });
}

// loaded on first use: users.json must be read first (the migration reads it)
let cache: Store | null = null;
const store = (): Store => (cache ??= load());

/** For tests: forget the loaded file. */
export const resetWorkspacesForTest = () => {
  cache = null;
};

/**
 * The workspace an account works in: a team before a free one (an account that had its own and then joined a team
 * works in the team), and among those the one it owns, else the first it joined.
 */
export function workspaceOf(username: string): Workspace | null {
  const mine = store().workspaces.filter((w) => w.members.some((m) => m.username === username));
  const owns = (w: Workspace) => w.members.some((m) => m.username === username && m.role === "owner");
  // ponytail: a free workspace's libraries drop out of the list once its owner joins a team (still reachable by id);
  // a workspace switcher when people need both
  const team = (w: Workspace) => w.plan === "team";
  return mine.find((w) => team(w) && owns(w)) ?? mine.find(team) ?? mine.find(owns) ?? mine[0] ?? null;
}

/**
 * The account's workspace, made on first need when it has none: a free workspace of its own, the account its owner
 * (a fresh install's first account, the local account when sign-in is off). Never for the demo account.
 */
export function ensureWorkspace(username: string): Workspace | null {
  const found = workspaceOf(username);
  if (found || username === "demo") return found;
  const now = Date.now();
  const w: Workspace = {
    id: randomUUID(),
    name: "Workspace",
    plan: "free",
    comped: false,
    createdAt: now,
    members: [{ username, role: "owner", ai: "own", budgetUsd: 0, joinedAt: now }],
  };
  store().workspaces.push(w);
  persist();
  return w;
}

export const memberIn = (w: Workspace, username: string): Member | null => w.members.find((m) => m.username === username) ?? null;
export const workspaceById = (id: string): Workspace | null => store().workspaces.find((w) => w.id === id) ?? null;
export const canManage = (role: WorkspaceRole | undefined) => role === "owner";

export function renameWorkspace(w: Workspace, name: string): void {
  const n = name.trim().slice(0, 60);
  if (!n) throw new Error("Give the workspace a name");
  w.name = n;
  persist();
}

const isAi = (x: unknown): x is AiRoute => x === "own" || x === "budget";

/**
 * An API budget spends the server's keys, so only the platform admin can give one: a workspace whose owner is a
 * platform admin (the solo install's own account when sign-in is off). Anyone else's workspace has nothing to pay with.
 */
export function serverPays(w: Workspace): boolean {
  const owner = w.members.find((m) => m.role === "owner")?.username ?? "";
  return findUser(owner)?.role === "admin" || (!env.appSecret && owner === LOCAL_USER.username);
}
const NO_BUDGET = "An API budget runs on this server's keys: only the server admin's workspace can give one. Members add their own AI or keys";
const checkAi = (w: Workspace, ai: unknown): AiRoute => {
  if (!isAi(ai)) throw new Error("AI is own or budget");
  if (ai === "budget" && !serverPays(w)) throw new Error(NO_BUDGET);
  return ai;
};
const budget = (x: unknown): number => {
  const n = typeof x === "number" && Number.isFinite(x) ? x : 0;
  if (n < 0 || n > 10_000) throw new Error("A budget is between $0 and $10,000 a month");
  return Math.round(n * 100) / 100;
};

/** Change a member's AI route or budget. `by` is the role of whoever asks: only the owner changes anyone. */
export function updateMember(w: Workspace, username: string, by: WorkspaceRole, patch: { ai?: unknown; budgetUsd?: unknown }): Member {
  const m = memberIn(w, username);
  if (!m) throw new Error("Not a member");
  if (by !== "owner") throw new Error("Only the owner changes the team");
  if (patch.ai !== undefined) m.ai = checkAi(w, patch.ai);
  if (patch.budgetUsd !== undefined) m.budgetUsd = budget(patch.budgetUsd);
  persist();
  return m;
}

/** Add an account as a member on its own AI (an account a platform admin makes in Admin → Users joins their workspace). */
export function addMember(w: Workspace, username: string): void {
  if (memberIn(w, username)) return;
  w.members.push({ username, role: "member", ai: "own", budgetUsd: 0, joinedAt: Date.now() });
  persist();
}

/** Take a member out (the account stays: it is the person's own). Nobody removes the owner. */
export function removeMember(w: Workspace, username: string, by: WorkspaceRole): void {
  const m = memberIn(w, username);
  if (!m) throw new Error("Not a member");
  if (by !== "owner") throw new Error("Only the owner changes the team");
  if (m.role === "owner") throw new Error("The owner can't be removed");
  w.members = w.members.filter((x) => x !== m);
  persist();
}

/** An account was deleted: out of every workspace, its invites and spend gone. */
export function forgetAccount(username: string): void {
  const s = store();
  for (const w of s.workspaces) w.members = w.members.filter((m) => m.username !== username);
  s.invites = s.invites.filter((i) => i.createdBy !== username);
  delete s.spend[username];
  persist();
}

/** A new invite link, always for a member: the token is returned once and kept hashed. */
export function createInvite(w: Workspace, by: { username: string; role: WorkspaceRole }, input: Partial<InviteInput>): { invite: Invite; token: string } {
  if (by.role !== "owner") throw new Error("Only the owner invites people");
  const ai = checkAi(w, input.ai ?? "own");
  const token = randomBytes(20).toString("hex");
  const now = Date.now();
  const invite: StoredInvite = {
    id: randomUUID(),
    workspaceId: w.id,
    ai,
    budgetUsd: budget(input.budgetUsd ?? 0),
    createdBy: by.username,
    createdAt: now,
    expiresAt: now + INVITE_DAYS * DAY,
    tokenHash: sha256(token),
  };
  store().invites.push(invite);
  persist();
  return { invite: publicInvite(invite), token };
}

const publicInvite = (i: StoredInvite): Invite => {
  const { tokenHash, ...rest } = i;
  void tokenHash;
  return rest;
};

/** Open invites of a workspace (expired ones dropped as they are read). */
export function invitesOf(w: Workspace): Invite[] {
  const s = store();
  const now = Date.now();
  const before = s.invites.length;
  s.invites = s.invites.filter((i) => i.expiresAt > now - 30 * DAY); // expired ones stay a month, then go
  if (s.invites.length !== before) persist();
  return s.invites.filter((i) => i.workspaceId === w.id && i.expiresAt > now).map(publicInvite);
}

export function revokeInvite(w: Workspace, id: string): boolean {
  const s = store();
  const before = s.invites.length;
  s.invites = s.invites.filter((i) => !(i.id === id && i.workspaceId === w.id));
  if (s.invites.length === before) return false;
  persist();
  return true;
}

/** The invite behind a link, expired or not; null when there is none (or its workspace is gone). */
export function inviteByToken(token: string): { invite: Invite; workspace: Workspace } | null {
  const hash = sha256(token);
  const i = store().invites.find((x) => x.tokenHash === hash);
  const w = i && workspaceById(i.workspaceId);
  return i && w ? { invite: publicInvite(i), workspace: w } : null;
}

/** Use an invite: the account joins with the invite's role and AI. The link works once. */
export function acceptInvite(token: string, username: string): Workspace {
  const found = inviteByToken(token);
  if (!found) throw new Error("This invite link doesn't work any more");
  const { invite, workspace } = found;
  if (invite.expiresAt <= Date.now()) throw new Error("This invite link has expired: ask for a new one");
  if (!memberIn(workspace, username)) {
    workspace.members.push({ username, role: "member", ai: invite.ai, budgetUsd: invite.budgetUsd, joinedAt: Date.now() });
  }
  store().invites = store().invites.filter((i) => i.id !== invite.id);
  persist();
  return workspace;
}

/** API spend this month (UTC), dollars. */
export const spentThisMonth = (username: string): number => store().spend[username]?.[month()] ?? 0;

/** An API answer billed to a member's budget. */
export function addSpend(username: string, usd: number): void {
  if (!(usd > 0)) return;
  const s = store();
  const m = month();
  const mine = (s.spend[username] ??= {});
  mine[m] = (mine[m] ?? 0) + usd;
  for (const k of Object.keys(mine).sort().slice(0, -12)) delete mine[k]; // a year
  persist();
}

/**
 * A member's monthly API budget, when that is their AI route: what is left this month (≤ 0 = used up).
 * Null = no budget route (their own AI, or not in a workspace).
 */
export function budgetLeft(username: string): number | null {
  const w = workspaceOf(username);
  const m = w && memberIn(w, username);
  // a budget set before this check, in a workspace the server doesn't pay for: no budget
  if (!m || m.ai !== "budget" || !serverPays(w)) return null;
  // ponytail: checked when a call starts, so one long call can go a little over; a hold per call if that matters
  return m.budgetUsd - spentThisMonth(username);
}

/** Wait for pending writes (tests). */
export const workspacesSaved = () => writeChain;
