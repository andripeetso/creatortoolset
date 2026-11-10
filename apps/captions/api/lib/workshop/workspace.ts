import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import type { SessionUser } from "../../users";
import type { Project } from "./types";
import { okId } from "./validate";

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

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

export async function readUserMarker(username: string): Promise<UserMarker | null> {
  return readJson<UserMarker>(markerPath(username));
}

export async function writeUserMarker(username: string, marker: UserMarker): Promise<void> {
  await writeJsonAtomic(markerPath(username), marker);
}

export async function ownedProjects(username: string): Promise<Project[]> {
  let names: string[] = [];
  try {
    names = (await readdir(PROJECTS)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Project[] = [];
  for (const name of names) {
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

export interface Workspace {
  currentProjectId: string | null;
  projects: Project[];
}

/** Own projects only. Picks the newest as current when none is set. */
export async function getWorkspace(user: SessionUser): Promise<Workspace> {
  const projects = await ownedProjects(user.username);
  const marker = (await readUserMarker(user.username)) ?? {};
  let current = marker.currentProjectId;
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
  if (!(await ownedProject(projectId, user))) {
    throw new Error("Not found");
  }
  await writeUserMarker(user.username, { ...marker, currentProjectId: projectId });
  return getWorkspace(user);
}

/** Prefer an explicit id the user owns, otherwise the current workspace project. */
export async function resolveProjectId(
  user: SessionUser,
  requested?: string | null,
): Promise<string | undefined> {
  if (requested && (await ownedProject(requested, user))) return requested;
  const { currentProjectId } = await getWorkspace(user);
  return currentProjectId ?? undefined;
}
