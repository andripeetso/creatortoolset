import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

const dataDir = mkdtempSync(path.join(tmpdir(), "retention-"));
process.env.DATA_DIR = dataDir;

const DAY = 86_400_000;
const now = Date.now();
const put = (rel: string, data: unknown) => {
  const p = path.join(dataDir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data));
};
const has = (rel: string) => existsSync(path.join(dataDir, rel));

const user = (username: string, role: string) => ({ username, role, salt: "", hash: "", createdAt: 0 });
put("users.json", { users: [user("boss", "admin"), user("robin", "team"), user("owen", "user")] });

const project = (id: string, owner: string | undefined, age: number, clip: Record<string, unknown> = {}) => {
  put(`projects/${id}/meta.json`, {
    id, name: id, owner, createdAt: 0, updatedAt: now - age * DAY, duration: 0,
    clips: [{ id: "clip-01", name: "a", duration: 0, createdAt: 0, ...clip }],
  });
  put(`projects/${id}/clips/clip-01/data.json`, { from: id });
  if (!clip.mediaProjectId) {
    put(`projects/${id}/clips/clip-01/original`, "video");
    put(`projects/${id}/clips/clip-01/proxy.mp4`, "proxy");
  }
};
project("owen-old", "owen", 20);
project("owen-new", "owen", 3);
project("robin-old", "robin", 90);
project("robin-mid", "robin", 20);
project("boss-old", "boss", 400);
project("ghost-new", "ghost", 1); // an account that was deleted
project("legacy-old", undefined, 400);
project("boss-copy", "boss", 30, { mediaProjectId: "owen-old" });

const review = (id: string, owner: string, age: number) =>
  put(`review/${id}/meta.json`, { id, name: id, owner, versions: [], approval: { status: "none" }, createdAt: 0, updatedAt: now - age * DAY });
const OWEN_VIDEO = "00000000-0000-4000-8000-000000000001";
const ROBIN_VIDEO = "00000000-0000-4000-8000-000000000002";
review(OWEN_VIDEO, "owen", 30);
review(ROBIN_VIDEO, "robin", 20);
const GUEST_OLD = "00000000-0000-4000-8000-000000000003";
const GUEST_NEW = "00000000-0000-4000-8000-000000000004";
review(GUEST_OLD, "guest-0123456789ab", 8); // guests have no account: kept 7 days
review(GUEST_NEW, "guest-0123456789ab", 3);
put("clips/ghost-note/meta.json", { owner: "ghost", updatedAt: now });
put("documents/owen-guide/meta.json", { owner: "owen", updatedAt: now - 15 * DAY });
put("documents/owen-fresh/meta.json", { owner: "owen", updatedAt: now });
put("enhance/robin-old/meta.json", { owner: "robin", updatedAt: now - 29 * DAY });
put("enhance/robin-old/source.wav", "audio");

const { sweepUserContent, deleteUserContent } = await import("./retention");

it("keeps a plain user's files 14 days, team's 28, admin's always, deleted accounts' not at all", async () => {
  await sweepUserContent();
  expect(has("projects/owen-old")).toBe(false);
  expect(has("projects/robin-old")).toBe(false);
  expect(has("enhance/robin-old")).toBe(false);
  expect(has("projects/ghost-new")).toBe(false);
  expect(has(`review/${OWEN_VIDEO}`)).toBe(false);
  expect(has(`review/${GUEST_OLD}`)).toBe(false);
  expect(has("clips/ghost-note")).toBe(false);
  expect(has("documents/owen-guide")).toBe(false);
  for (const kept of ["projects/owen-new", "projects/robin-mid", "projects/boss-old", "projects/legacy-old", `review/${ROBIN_VIDEO}`, `review/${GUEST_NEW}`, "documents/owen-fresh"]) {
    expect(has(kept)).toBe(true);
  }
});

it("hands a purged project's video to the admin copy that borrows it", () => {
  const clip = "projects/boss-copy/clips/clip-01";
  expect(readFileSync(path.join(dataDir, clip, "original"), "utf-8")).toBe("video");
  expect(readFileSync(path.join(dataDir, clip, "data.json"), "utf-8")).toContain("boss-copy");
  const meta = JSON.parse(readFileSync(path.join(dataDir, "projects/boss-copy/meta.json"), "utf-8"));
  expect(meta.clips[0].mediaProjectId).toBeUndefined();
});

it("deleting an account takes everything it owned", async () => {
  await deleteUserContent("robin");
  expect(has("projects/robin-mid")).toBe(false);
  expect(has(`review/${ROBIN_VIDEO}`)).toBe(false);
  expect(has("projects/owen-new")).toBe(true);
});
