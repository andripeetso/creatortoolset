import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { purgeExpiredProjects } from "./projects";
import { purgeExpiredReview } from "./review";
import { env } from "./lib/env";
import { adminCount, findUser, wasDeleted } from "./users";

/**
 * What happens to accounts' files. Each account keeps its own work and clears it itself (Settings → Storage lists what
 * it keeps, api/kept.ts): nothing is deleted for its age. Deleting an account deletes everything it owned right away,
 * and anything still owned by a deleted account (deleteUser's mark) goes on the next sweep.
 * A server that wants an age limit sets CONTENT_EXPIRES=1: then Caption Studio projects (originals included), Review
 * videos and their folders, Audio Enhancer sessions and guides that haven't changed for 14 days (plain `user`) or
 * 28 days (team) are deleted for good. Admins keep theirs. Video Notes (clips) are shared links, and Review videos are
 * Media Library files: those go only with their account. Exports stay until removed in Settings → Storage.
 */
export const KEEP_DAYS = { user: 14, team: 28 } as const;

/** The days a role's files stay on a server with the age limit on; undefined when they stay (no limit, or an admin). */
export const keepDaysFor = (role: string): number | undefined =>
  process.env.CONTENT_EXPIRES === "1" && (role === "user" || role === "team") ? KEEP_DAYS[role] : undefined;

/** Does the item `owner` last changed at `at` (epoch ms) go? */
export type Expired = (owner: string | undefined, at: number) => boolean;

export function retentionRule(now = Date.now()): Expired {
  return (owner, at) => {
    if (!owner) return false; // pre-account saves are the admin's
    const user = findUser(owner);
    // only a deleted one: an account made on the other server process during a swap isn't known here yet
    if (!user) return wasDeleted(owner);
    const days = keepDaysFor(user.role);
    return days !== undefined && at < now - days * 86_400_000;
  };
}

/**
 * `<root>/<id>/meta.json` stores with `owner` + `updatedAt` (Video Notes, guides, Audio Enhancer). A meta with no
 * `updatedAt` counts from the file's own modified time, so a new one is never judged as already 1970.
 */
async function purgeMetaDirs(root: string, expired: Expired): Promise<void> {
  for (const id of await readdir(root).catch(() => [] as string[])) {
    const file = path.join(root, id, "meta.json");
    const meta = await readFile(file, "utf-8")
      .then((s) => JSON.parse(s) as { owner?: string; updatedAt?: number })
      .catch(() => null);
    if (!meta) continue;
    const at = meta.updatedAt ?? (await stat(file).then((s) => s.mtimeMs, () => null));
    if (at !== null && expired(meta.owner, at)) await rm(path.join(root, id), { recursive: true, force: true });
  }
}

/**
 * `designs/<owner>/<id>.json` with its pictures in `<id>/` (api/designs.ts): the folder's name is the owner. The
 * account's own fonts (`.fonts/`) never go for their age: they go with the account.
 */
async function purgeDesigns(expired: Expired): Promise<void> {
  const root = path.join(env.dataDir, "designs");
  for (const owner of await readdir(root).catch(() => [] as string[])) {
    // judged as changed just now: only an account that is gone gives them up
    if (expired(owner, Date.now())) await rm(path.join(root, owner, ".fonts"), { recursive: true, force: true });
    for (const name of await readdir(path.join(root, owner)).catch(() => [] as string[])) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(root, owner, name);
      const at =
        (await readFile(file, "utf-8").then((s) => (JSON.parse(s) as { updatedAt?: number }).updatedAt, () => undefined)) ?? (await stat(file).then((s) => s.mtimeMs, () => null));
      if (at == null || !expired(owner, at)) continue;
      await rm(file, { force: true });
      await rm(file.slice(0, -5), { recursive: true, force: true });
    }
  }
}

// gone: what only a gone account takes, never its age: a clip is a shared link, a Review video a Media Library file
async function purge(expired: Expired, gone: Expired = expired): Promise<void> {
  for (const step of [
    () => purgeExpiredProjects(expired),
    () => purgeExpiredReview(gone),
    () => purgeMetaDirs(path.join(env.dataDir, "clips"), gone),
    () => purgeMetaDirs(path.join(env.dataDir, "documents"), expired),
    () => purgeMetaDirs(path.join(env.dataDir, "enhance"), expired),
    () => purgeDesigns(expired),
  ]) {
    await step().catch((e) => console.error("[retention]", e));
  }
}

/** Everything a deleted account owned, now. */
export const deleteUserContent = (username: string) => purge((owner) => owner === username);

export async function sweepUserContent(): Promise<void> {
  // users.json unread = every owner would look deleted
  if (adminCount() === 0) return;
  await purge(retentionRule(), (owner) => !!owner && !findUser(owner) && wasDeleted(owner));
}

// production only: dev servers share ~/.caption-studio with test data
if (env.isProduction && env.appSecret) {
  void sweepUserContent();
  setInterval(() => void sweepUserContent(), 6 * 3600_000).unref();
}
