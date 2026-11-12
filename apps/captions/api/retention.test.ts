import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
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
put("users.json", { users: [user("owner-admin", "admin"), user("team-member", "team"), user("plain-user", "user")] });

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
project("plain-old", "plain-user", 20);
project("plain-new", "plain-user", 3);
project("team-old", "team-member", 90);
project("team-mid", "team-member", 20);
project("admin-old", "owner-admin", 400);
project("gone-new", "removed-account", 1); // an account that was deleted
project("legacy-old", undefined, 400);
project("admin-copy", "owner-admin", 30, { mediaProjectId: "plain-old" });

const review = (id: string, owner: string, age: number) =>
  put(`review/${id}/meta.json`, { id, name: id, owner, versions: [], approval: { status: "none" }, createdAt: 0, updatedAt: now - age * DAY });
const PLAIN_VIDEO = "00000000-0000-4000-8000-000000000001";
const TEAM_VIDEO = "00000000-0000-4000-8000-000000000002";
review(PLAIN_VIDEO, "plain-user", 30);
review(TEAM_VIDEO, "team-member", 20);
// an account that no longer exists: no account behind it, so it goes
const ORPHAN_VIDEO = "00000000-0000-4000-8000-000000000003";
review(ORPHAN_VIDEO, "removed-account", 0);
put("clips/gone-note/meta.json", { owner: "removed-account", updatedAt: now });
put("documents/plain-guide/meta.json", { owner: "plain-user", updatedAt: now - 15 * DAY });
put("documents/plain-fresh/meta.json", { owner: "plain-user", updatedAt: now });
put("enhance/team-old/meta.json", { owner: "team-member", updatedAt: now - 29 * DAY });
put("enhance/team-old/source.wav", "audio");
// a Video Note with no updatedAt: its file's own age decides
put("clips/day-one-note/meta.json", { owner: "plain-user" });
put("clips/old-note/meta.json", { owner: "plain-user" });
utimesSync(path.join(dataDir, "clips/old-note/meta.json"), (now - 20 * DAY) / 1000, (now - 20 * DAY) / 1000);

const { sweepUserContent, deleteUserContent } = await import("./retention");

it("with no age limit, only a deleted account's files go", async () => {
  await sweepUserContent();
  expect(has("projects/gone-new")).toBe(false);
  expect(has("projects/plain-old")).toBe(true);
  expect(has("projects/team-old")).toBe(true);
  expect(has(`review/${PLAIN_VIDEO}`)).toBe(true);
});

it("CONTENT_EXPIRES=1: keeps a plain user's files 14 days, team's 28, admin's always, deleted accounts' not at all", async () => {
  process.env.CONTENT_EXPIRES = "1";
  await sweepUserContent();
  delete process.env.CONTENT_EXPIRES;
  expect(has("projects/plain-old")).toBe(false);
  expect(has("projects/team-old")).toBe(false);
  expect(has("enhance/team-old")).toBe(false);
  expect(has("projects/gone-new")).toBe(false);
  expect(has(`review/${PLAIN_VIDEO}`)).toBe(false);
  expect(has(`review/${ORPHAN_VIDEO}`)).toBe(false);
  expect(has("clips/gone-note")).toBe(false);
  expect(has("documents/plain-guide")).toBe(false);
  expect(has("clips/old-note")).toBe(true); // a clip is a shared link: age never deletes it
  for (const kept of ["projects/plain-new", "projects/team-mid", "projects/admin-old", "projects/legacy-old", `review/${TEAM_VIDEO}`, "documents/plain-fresh"]) {
    expect(has(kept)).toBe(true);
  }
});

it("a Video Note with no updatedAt is not purged on the day it is made", () => {
  expect(has("clips/day-one-note/meta.json")).toBe(true);
});

it("hands a purged project's video to the admin copy that borrows it", () => {
  const clip = "projects/admin-copy/clips/clip-01";
  expect(readFileSync(path.join(dataDir, clip, "original"), "utf-8")).toBe("video");
  expect(readFileSync(path.join(dataDir, clip, "data.json"), "utf-8")).toContain("admin-copy");
  const meta = JSON.parse(readFileSync(path.join(dataDir, "projects/admin-copy/meta.json"), "utf-8"));
  expect(meta.clips[0].mediaProjectId).toBeUndefined();
});

it("deleting an account takes everything it owned", async () => {
  await deleteUserContent("team-member");
  expect(has("projects/team-mid")).toBe(false);
  expect(has(`review/${TEAM_VIDEO}`)).toBe(false);
  expect(has("projects/plain-new")).toBe(true);
});
