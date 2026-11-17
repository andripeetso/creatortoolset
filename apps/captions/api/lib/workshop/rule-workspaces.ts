import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";

/**
 * Where a writing rule or a framework applies (owner, 2026-11-16: "They should be shared across, however I should be able
 * to also assign some things to a specific workspace only and change them specifically for workspace only"). The same
 * choice as a plug-in's (plugin-workspaces.ts): All workspaces (no `only`), or Only these (`only`). One shared by more
 * than one workspace can be changed for one of them: that workspace's version (`versions[id]`) is used there in its
 * place, under the shared one's id, so a piece's chosen rules and a workspace's `off` list keep naming it. Deleting the
 * version brings the shared one back there.
 */
export interface Scoped {
  id: string;
  updatedAt: number;
  /** The workspaces it applies in; missing = every workspace. */
  only?: string[];
  /** A workspace's own version, used there in its place: workspace id → the fields as changed there. */
  versions?: Record<string, Record<string, unknown> & { updatedAt: number }>;
}

/** What a list or a prompt gets: no other workspace's version, and `changedHere` when this one has its own. */
export type AsIn<T extends Scoped> = Omit<T, "versions"> & { changedHere?: true };

export const appliesIn = (x: Pick<Scoped, "only">, workspace?: string | null): boolean => !workspace || !x.only || x.only.includes(workspace);

/** One rule or framework as used in `workspace` (none: the shared one), or null when it does not apply there. */
export function asIn<T extends Scoped>(x: T, workspace?: string | null): AsIn<T> | null {
  if (!appliesIn(x, workspace)) return null;
  const { versions, ...shared } = x;
  const own = workspace ? versions?.[workspace] : undefined;
  return own ? { ...shared, ...own, id: x.id, changedHere: true } : shared;
}

/** The ones that apply in `workspace`, each as used there. */
export const allIn = <T extends Scoped>(items: T[], workspace?: string | null): Array<AsIn<T>> =>
  items.flatMap((x) => asIn(x, workspace) ?? []);

/** `x` with `workspace` gone from it: null = unchanged, "delete" = its Only these list lost its last workspace. */
export function withoutWorkspace<T extends Scoped>(x: T, workspace: string): T | "delete" | null {
  if (!x.only?.includes(workspace) && !x.versions?.[workspace]) return null;
  const only = x.only?.filter((id) => id !== workspace);
  if (only && !only.length) return "delete";
  const rest = sharedAgainIn(x, workspace);
  return only ? { ...rest, only } : rest;
}

/** `x` with `workspace`'s own version deleted: the shared one is used there again. */
export function sharedAgainIn<T extends Scoped>(x: T, workspace: string): T {
  const { [workspace]: _, ...versions } = x.versions ?? {};
  const { versions: __, ...rest } = x;
  return { ...rest, ...(Object.keys(versions).length ? { versions } : {}) } as T;
}

type Kind = "rules" | "frameworks";

/** Every rule or framework on file, with the file it is in. */
async function records(kind: Kind): Promise<Array<{ file: string; rec: (Scoped & { owner?: string }) | null }>> {
  const dir = path.join(env.dataDir, "workshop", kind);
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json"));
  return Promise.all(
    names.map(async (name) => {
      const file = path.join(dir, name);
      return { file, rec: await readFile(file, "utf-8").then((t) => JSON.parse(t) as Scoped & { owner?: string }, () => null) };
    }),
  );
}

/** How many of `owner`'s rules or frameworks are kept to `workspace` alone: what deleting it deletes (its confirm counts them). */
export const keptOnlyTo = async (kind: Kind, owner: string, workspace: string): Promise<number> =>
  (await records(kind)).filter(({ rec }) => rec?.owner === owner && withoutWorkspace(rec, workspace) === "delete").length;

/**
 * A deleted workspace leaves every rule and framework: dropped from each Only these list (one left with none is
 * deleted) and its own versions deleted. Run by the workspace delete (lib/workspace-delete.ts).
 */
export async function dropWorkspaceFromRules(workspace: string): Promise<void> {
  for (const kind of ["rules", "frameworks"] as const) {
    for (const { file, rec } of await records(kind)) {
      const next = rec && withoutWorkspace(rec, workspace);
      if (next === "delete") await rm(file, { force: true });
      else if (next) await writeFile(`${file}.tmp-${process.pid}`, JSON.stringify(next)).then(() => rename(`${file}.tmp-${process.pid}`, file));
    }
  }
}
