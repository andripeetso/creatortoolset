import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { purgeExpiredProjects } from "./projects";
import { purgeExpiredReview } from "./review";
import { env } from "./lib/env";
import { DEMO_USER, adminCount, findUser, isDemoName, isGuestName } from "./users";

/**
 * How long accounts' files stay: so other people's
 * media never fills the server. Caption Studio projects (originals
 * included), Review videos and their folders, Audio Enhancer sessions,
 * Video Notes and guides are deleted for good once they haven't changed
 * for 14 days (plain `user`) or 28 days (team); admins keep theirs.
 * Deleting an account deletes everything it owned right away, and anything
 * still owned by an account that no longer exists goes on the next sweep.
 * Exports expire on their own after EXPORTS_KEEP_HOURS (api/exports.ts).
 */
export const KEEP_DAYS = { user: 14, team: 28 } as const;
/** A guest's Review videos: as long as the guest cookie lasts (auth.ts GUEST_MAX_AGE). */
export const GUEST_KEEP_DAYS = 7;
/** A demo visitor's copy of the demo's Review: as long as their demo cookie (auth.ts DEMO_MAX_AGE). */
export const DEMO_KEEP_DAYS = 1;

/** Does the item `owner` last changed at `at` (epoch ms) go? */
export type Expired = (owner: string | undefined, at: number) => boolean;

export function retentionRule(now = Date.now()): Expired {
  return (owner, at) => {
    if (!owner) return false; // pre-account saves are the admin's
    if (isGuestName(owner)) return at < now - GUEST_KEEP_DAYS * 86_400_000;
    if (isDemoName(owner)) return at < now - DEMO_KEEP_DAYS * 86_400_000;
    const user = findUser(owner);
    if (!user) return true;
    if (user.role === "admin" || user.username === DEMO_USER) return false; // the demo stays as filled
    return at < now - KEEP_DAYS[user.role] * 86_400_000;
  };
}

/** `<root>/<id>/meta.json` stores with `owner` + `updatedAt` (Video Notes, guides, Audio Enhancer). */
async function purgeMetaDirs(root: string, expired: Expired): Promise<void> {
  for (const id of await readdir(root).catch(() => [] as string[])) {
    const meta = await readFile(path.join(root, id, "meta.json"), "utf-8")
      .then((s) => JSON.parse(s) as { owner?: string; updatedAt?: number })
      .catch(() => null);
    if (meta && expired(meta.owner, meta.updatedAt ?? 0)) {
      await rm(path.join(root, id), { recursive: true, force: true });
    }
  }
}

async function purge(expired: Expired): Promise<void> {
  for (const step of [
    () => purgeExpiredProjects(expired),
    () => purgeExpiredReview(expired),
    () => purgeMetaDirs(path.join(env.dataDir, "clips"), expired),
    () => purgeMetaDirs(path.join(env.dataDir, "documents"), expired),
    () => purgeMetaDirs(path.join(env.dataDir, "enhance"), expired),
  ]) {
    await step().catch((e) => console.error("[retention]", e));
  }
}

/** Everything a deleted account owned, now. */
export const deleteUserContent = (username: string) =>
  purge((owner) => owner === username);

export async function sweepUserContent(): Promise<void> {
  // users.json unread = every owner would look deleted
  if (adminCount() === 0) return;
  await purge(retentionRule());
}

// production only: dev servers share ~/.caption-studio with test data
if (env.isProduction && env.appSecret) {
  void sweepUserContent();
  setInterval(() => void sweepUserContent(), 6 * 3600_000).unref();
}
