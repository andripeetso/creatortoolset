import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { purgeExpiredProjects } from "./projects";
import { purgeExpiredReview } from "./review";
import { env } from "./lib/env";
import { adminCount, findUser } from "./users";

/**
 * What happens to accounts' files. Each account keeps its own work and clears it itself (Settings → Storage lists what
 * it keeps, api/kept.ts): nothing is deleted for its age. Deleting an account deletes everything it owned right away,
 * and anything still owned by an account that no longer exists goes on the next sweep.
 * A server that wants an age limit sets CONTENT_EXPIRES=1: then Caption Studio projects (originals included), Review
 * videos and their folders, Audio Enhancer sessions and guides that haven't changed for 14 days (plain `user`) or
 * 28 days (team) are deleted for good. Admins keep theirs; Video Notes (clips) are shared links and stay.
 * Exports expire on their own after EXPORTS_KEEP_HOURS (api/exports.ts).
 */
export const KEEP_DAYS = { user: 14, team: 28 } as const;

/** Does the item `owner` last changed at `at` (epoch ms) go? */
export type Expired = (owner: string | undefined, at: number) => boolean;

export function retentionRule(now = Date.now()): Expired {
  return (owner, at) => {
    if (!owner) return false; // pre-account saves are the admin's
    const user = findUser(owner);
    if (!user) return true;
    if (user.role === "admin" || process.env.CONTENT_EXPIRES !== "1") return false;
    return at < now - KEEP_DAYS[user.role] * 86_400_000;
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

// clipsExpired: a clip is a shared link, so the age sweep keeps it and only a gone account takes it.
async function purge(expired: Expired, clipsExpired: Expired = expired): Promise<void> {
  for (const step of [
    () => purgeExpiredProjects(expired),
    () => purgeExpiredReview(expired),
    () => purgeMetaDirs(path.join(env.dataDir, "clips"), clipsExpired),
    () => purgeMetaDirs(path.join(env.dataDir, "documents"), expired),
    () => purgeMetaDirs(path.join(env.dataDir, "enhance"), expired),
  ]) {
    await step().catch((e) => console.error("[retention]", e));
  }
}

/** Everything a deleted account owned, now. */
export const deleteUserContent = (username: string) => purge((owner) => owner === username);

export async function sweepUserContent(): Promise<void> {
  // users.json unread = every owner would look deleted
  if (adminCount() === 0) return;
  await purge(retentionRule(), (owner) => !!owner && !findUser(owner));
}

// production only: dev servers share ~/.caption-studio with test data
if (env.isProduction && env.appSecret) {
  void sweepUserContent();
  setInterval(() => void sweepUserContent(), 6 * 3600_000).unref();
}
