import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";

// An owner's or admin's Approve puts the newest version in Finals (review.ts approval, owner 2026-11-19); a plug-in's
// guard can refuse it, and the approval stands with the reason. Finals takes 1080p or more, so this makes a real clip.

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "review-approve-finals-"));
process.env.DATA_DIR = dir;
process.env.APP_SECRET = "review-approve-finals-secret";
process.env.LIBRARY_DISK_RESERVE_GB = "0";
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const { createUser, setOff } = await import("./users");
const app = (await import("./boot")).default;
const { definePlugin, mountPlugins } = await import("./lib/plugin");
const { libraryDb } = await import("./library/db");
const { addVersion, readMeta, reviewJobsDone } = await import("./review");
afterAll(() => {
  mountPlugins(new Hono(), []);
  rmSync(dir, { recursive: true, force: true });
});

const cookies: Record<string, string> = {};
async function account(username: string) {
  setOff(createUser(username, "password1", { role: "user" }), []);
  const res = await app.request("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username, password: "password1" }) });
  cookies[username] = res.headers.get("set-cookie")!.split(";")[0]!;
}
const approve = async (user: string, asset: string, status: string) =>
  (await app.request(`/api/review/assets/${asset}/approval`, {
    method: "POST",
    headers: { cookie: cookies[user]!, "content-type": "application/json" },
    body: JSON.stringify({ status }),
  })).json() as Promise<{ approval: { status: string }; finals?: { pieceId: string } | { error: string } }>;
const items = (label: string) =>
  (libraryDb().prepare("SELECT COUNT(*) AS n FROM piece_items i JOIN pieces p ON p.id = i.piece_id WHERE p.label = ?").get(label) as { n: number }).n;

async function video(owner: string, name: string): Promise<string> {
  const clip = path.join(dir, `${name}.mp4`);
  spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc=size=1080x1920:rate=25:duration=1", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", clip]);
  const added = await addVersion(undefined, { owner, name: `${name}.mp4`, mime: "video/mp4", bytes: statSync(clip).size }, async (dest) => copyFileSync(clip, dest));
  const id = added!.meta.id;
  await reviewJobsDone();
  for (let i = 0; i < 200 && !(await readMeta(id))?.versions[0]?.versionId; i++) await new Promise((r) => setTimeout(r, 50));
  return id;
}

describe.skipIf(!hasFfmpeg)("Approve sends to Finals", () => {
  it("the owner's Approve puts the newest version in Finals once; Needs review sends nothing", async () => {
    await account("maker");
    const id = await video("maker", "Tiny Acrobatics story");
    const label = (await readMeta(id))!.name;
    expect(await approve("maker", id, "needs_review")).not.toHaveProperty("finals");
    expect(items(label)).toBe(0);
    const first = await approve("maker", id, "approved");
    expect(first.approval.status).toBe("approved");
    expect(first.finals).toEqual({ pieceId: expect.any(String) });
    expect(items(label)).toBe(1);
    await approve("maker", id, "approved"); // again: the library holds the version once
    expect(items(label)).toBe(1);
  });

  it("a guard's refusal comes back with the approval, which stands; the guard sees the version", async () => {
    await account("held");
    const id = await video("held", "Tiny Acrobatics held");
    const versionId = (await readMeta(id))!.versions[0]!.versionId;
    const seen: unknown[] = [];
    mountPlugins(new Hono(), [definePlugin({ id: "tiny-guard", finals: { beforeAdd: (_i, s) => (seen.push(s), "Blur it first") } })]);
    const out = await approve("held", id, "approved");
    mountPlugins(new Hono(), []);
    expect(out.approval.status).toBe("approved");
    expect(out.finals).toEqual({ error: "Blur it first" });
    expect(seen).toEqual([{ versionId }]);
    expect(items((await readMeta(id))!.name)).toBe(0);
  });
});
