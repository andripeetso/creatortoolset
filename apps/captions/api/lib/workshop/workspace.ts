import { AsyncLocalStorage } from "node:async_hooks";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import type { SessionUser } from "../../users";
import type { Project } from "./types";
import { okId } from "./validate";
import { sharedWith } from "../workspaces";
import { writeJsonAtomic } from "../write-json";

/**
 * Account-level current project: the brand profile Analyzer and Workshop
 * share. Caption Studio clip-pools are a different "project" and stay
 * out of this file.
 *
 * $DATA_DIR/workshop/users/<username>.json  { seeded, currentProjectId }
 */

const USERS = path.join(env.dataDir, "workshop", "users");
const PROJECTS = path.join(env.dataDir, "workshop", "projects");

export interface UserMarker {
  seededAt?: number;
  seeded?: string[];
  currentProjectId?: string;
  /** when the records from before projects were kept apart went into the first brand's project (scopeOldRecords) */
  scopedAt?: number;
}

export function inProject(
  record: { projectId?: string },
  projectId?: string | null,
): boolean {
  if (!projectId) return true;
  return !record.projectId || record.projectId === projectId;
}

/**
 * Which project each of the user's Instagram accounts belongs to: the one that links it as its own
 * (Project.accountId). A second brand's account and posts stay out of the first brand's project.
 */
export async function accountProjects(username: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const p of await ownedProjects(username)) if (p.accountId && !out.has(p.accountId)) out.set(p.accountId, p.id);
  return out;
}

/** The account is not this user's own after all: no project of theirs keeps it as its Instagram. */
export async function unlinkAccount(username: string, accountId: string): Promise<void> {
  for (const p of await ownedProjects(username)) {
    if (p.accountId !== accountId) continue;
    const { accountId: _, ...rest } = p;
    await writeJsonAtomic(projectPath(p.id), { ...rest, updatedAt: Date.now() });
  }
}

/** Ids switched on for a project: every one of the account's, minus the project's `off` list. */
export const onFor = <T extends { id: string }>(items: T[], project?: Pick<Project, "off"> | null): T[] =>
  project?.off?.length ? items.filter((i) => !project.off!.includes(i.id)) : items;

export function markerPath(username: string): string {
  return path.join(USERS, `${username}.json`);
}

const projectPath = (id: string) => path.join(PROJECTS, `${id}.json`);

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}


export async function readUserMarker(username: string): Promise<UserMarker | null> {
  return readJson<UserMarker>(markerPath(username));
}

export async function writeUserMarker(username: string, marker: UserMarker): Promise<void> {
  await writeJsonAtomic(markerPath(username), marker);
}

/**
 * Each project file's owner, read once: the folder is listed each time (a project added or removed shows at once), and
 * a project's owner never changes, so only a new file is opened to learn it.
 */
const owners = new Map<string, string>();

async function projectOwners(): Promise<Map<string, string>> {
  const names = new Set((await readdir(PROJECTS).catch(() => [] as string[])).filter((n) => n.endsWith(".json")));
  for (const name of owners.keys()) if (!names.has(name)) owners.delete(name);
  for (const name of names) {
    if (owners.has(name)) continue;
    const owner = (await readJson<Project>(path.join(PROJECTS, name)))?.owner;
    if (owner) owners.set(name, owner); // one that can't be read now is tried again next time
  }
  return owners;
}

export async function ownedProjects(username: string): Promise<Project[]> {
  const out: Project[] = [];
  for (const [name, owner] of await projectOwners()) {
    if (owner !== username) continue;
    // read fresh: a project's name and fields change with each save
    const rec = await readJson<Project>(path.join(PROJECTS, name));
    if (rec?.owner === username) out.push(rec);
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function ownedProject(id: string, user: SessionUser): Promise<Project | null> {
  if (!okId(id)) return null;
  const p = await readJson<Project>(projectPath(id));
  return p && p.owner === user.username ? p : null;
}

/**
 * The team owner's workspaces this account was given (Settings → Team → Access; sharedWith, lib/workspaces.ts), read
 * fresh each time, so taking one away holds at once. A deleted one drops out. They are the owner's: never edited here.
 */
export async function sharedProjects(username: string): Promise<Project[]> {
  const s = sharedWith(username);
  const out: Project[] = [];
  for (const id of s?.ids ?? []) {
    const p = okId(id) ? await readJson<Project>(projectPath(id)) : null;
    if (p && p.owner === s!.owner) out.push(p);
  }
  return out;
}

/**
 * What an invite says it is for (the email, the join page): the names of the owner's workspaces it gives, as one line
 * ("Tiny Acrobatics and Northlight"), else the server's own name (its host): the person joins the server either way.
 */
export async function inviteTarget(owner: string, ids: string[] | undefined, host: string): Promise<string> {
  const names: string[] = [];
  for (const id of ids ?? []) {
    const p = okId(id) ? await readJson<Project>(projectPath(id)) : null;
    if (p?.owner === owner) names.push(p.name);
  }
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? host);
}

/** A workspace this account may work in: its own, or one given to it. */
async function openableProject(id: string, user: SessionUser): Promise<Project | null> {
  return (await ownedProject(id, user)) ?? (await sharedProjects(user.username)).find((p) => p.id === id) ?? null;
}

/** The workspace this request works in, when it is one given to this account: whose it is. Null for one's own. */
export async function sharedHere(user: SessionUser): Promise<{ owner: string; id: string } | null> {
  const { currentProjectId, projects } = await getWorkspace(user);
  const p = projects.find((x) => x.id === currentProjectId);
  return p && p.owner !== user.username ? { owner: p.owner, id: p.id } : null;
}

/**
 * The workspace a chat's reply works in (assistant.ts, mcp.ts): while it is set, it is the current one for this call
 * and everything it calls, whatever the app has open. Never written down: the app's own pick stays as it was.
 */
export const workspaceScope = new AsyncLocalStorage<{ id: string; turn?: string }>();

/** A chat's reply switched workspace (setCurrentProjectId inside its scope): the chat moves there too (assistant.ts). */
let chatMoves: ((username: string, turn: string, id: string) => void) | undefined;
export const onChatMoves = (fn: typeof chatMoves) => void (chatMoves = fn);

export interface Workspace {
  currentProjectId: string | null;
  projects: Project[];
}

/** Own projects, then the ones given to this account (sharedProjects). Picks the newest as current when none is set. */
export async function getWorkspace(user: SessionUser): Promise<Workspace> {
  const projects = [...(await ownedProjects(user.username)), ...(await sharedProjects(user.username))];
  const marker = (await readUserMarker(user.username)) ?? {};
  const scoped = workspaceScope.getStore()?.id;
  let current = scoped && projects.some((p) => p.id === scoped) ? scoped : marker.currentProjectId;
  if (current && !projects.some((p) => p.id === current)) current = undefined;
  if (!current && projects[0]) {
    current = projects[0].id;
    await writeUserMarker(user.username, { ...marker, currentProjectId: current });
  }
  return { currentProjectId: current ?? null, projects };
}

export async function setCurrentProjectId(
  user: SessionUser,
  projectId: string | null,
): Promise<Workspace> {
  const marker = (await readUserMarker(user.username)) ?? {};
  if (!projectId) {
    const { currentProjectId: _, ...rest } = marker;
    await writeUserMarker(user.username, rest);
    return getWorkspace(user);
  }
  if (!(await openableProject(projectId, user))) {
    throw new Error("Not found");
  }
  await writeUserMarker(user.username, { ...marker, currentProjectId: projectId });
  movesTo(user, projectId);
  return getWorkspace(user);
}

/** Asked by a chat's reply: the chat, and the rest of this call, work in `projectId` from now on. Also when a reply
 *  makes something in another workspace by naming it (owner, 2026-11-15: a chat filed under one brand wrote its
 *  Workshop project in another and kept the first one's badge). */
export function movesTo(user: SessionUser, projectId: string): void {
  const scope = workspaceScope.getStore();
  if (!scope || scope.id === projectId) return;
  scope.id = projectId;
  if (scope.turn) chatMoves?.(user.username, scope.turn, projectId);
}

/** Prefer an explicit id the user owns, otherwise the current workspace project. */
export async function resolveProjectId(
  user: SessionUser,
  requested?: string | null,
): Promise<string | undefined> {
  if (requested && (await openableProject(requested, user))) {
    movesTo(user, requested);
    return requested;
  }
  const { currentProjectId } = await getWorkspace(user);
  return currentProjectId ?? undefined;
}
