import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionUser } from "./users";

// clipWithCaptions and addEditedClip: how a tool outside Caption Studio (a plug-in) takes a clip out with its captions
// and hands an edited one back. Nothing in the app itself calls them, so this is their check.
const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "projects-handover-"));
process.env.DATA_DIR = root;
afterAll(() => rmSync(root, { recursive: true, force: true }));
const available = spawnSync("ffmpeg", ["-version"]).status === 0;
const { addEditedClip, clipWithCaptions } = await import("./projects");

const owner: SessionUser = { username: "owner", role: "user", cloud: false, off: [] };
const stranger: SessionUser = { ...owner, username: "stranger" };
const projectId = randomUUID();
const clipId = randomUUID();
const projectDir = path.join(root, "projects", projectId);
const video = path.join(root, "clip.mp4");
const meta = () => JSON.parse(readFileSync(path.join(projectDir, "meta.json"), "utf8")) as { revision: number; clips: { id: string; name: string }[] };
const edited = (transferId: string, origin?: { projectId: string; clipId: string; revision: number }) =>
  addEditedClip({ user: owner, file: video, name: "clip · edited.mp4", duration: 2, width: 320, height: 180, data: { words: [{ id: 1, text: "hello", start: 0.5, end: 1 }] }, transferId, origin, scenes: 1 });

beforeAll(() => {
  if (!available) return;
  const made = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv420p", video]);
  expect(made.status, made.stderr.toString()).toBe(0);
  mkdirSync(path.join(projectDir, "clips", clipId), { recursive: true });
  writeFileSync(path.join(projectDir, "clips", clipId, "original"), readFileSync(video));
  writeFileSync(path.join(projectDir, "clips", clipId, "data.json"), JSON.stringify({ words: [{ id: 1, text: "hello", start: 0.5, end: 1 }] }));
  writeFileSync(
    path.join(projectDir, "meta.json"),
    JSON.stringify({ id: projectId, name: "Tiny Acrobatics", owner: "owner", createdAt: 1, updatedAt: 1, duration: 2, revision: 3, clips: [{ id: clipId, name: "clip.mp4", duration: 2, createdAt: 1 }] }),
  );
});

describe.skipIf(!available)("a clip handed out of Caption Studio and back", () => {
  it("gives the owner the clip's source, its captions and the project's revision; nobody else", async () => {
    const out = await clipWithCaptions(projectId, clipId, owner);
    expect(out).toMatchObject({ name: "clip.mp4", origin: { projectId, clipId, revision: 3 }, data: { words: [{ text: "hello" }] } });
    expect(readFileSync(out.file)).toEqual(readFileSync(video));
    await expect(clipWithCaptions(projectId, clipId, stranger)).rejects.toMatchObject({ status: 404 });
  });

  it("adds the edited clip beside the first one, once for one hand-over, and refuses a project that changed since", async () => {
    const origin = { projectId, clipId, revision: 3 };
    const first = await edited("t1", origin);
    expect(first.projectId).toBe(projectId);
    expect(first.clipId).not.toBe(clipId);
    expect(meta()).toMatchObject({ revision: 4, clips: [{ id: clipId }, { id: first.clipId, name: "clip · edited.mp4" }] });
    expect(JSON.parse(readFileSync(path.join(projectDir, "clips", first.clipId, "data.json"), "utf8"))).toMatchObject({ words: [{ text: "hello" }] });
    // the same hand-over again (a retry) is the same clip
    expect(await edited("t1", origin)).toEqual(first);
    expect(meta().clips).toHaveLength(2);
    // another hand-over that started from the old revision
    await expect(edited("t2", origin)).rejects.toMatchObject({ status: 409 });
    // the first clip is as it was
    expect(readFileSync(path.join(projectDir, "clips", clipId, "original"))).toEqual(readFileSync(video));
  }, 30_000);

  it("makes a new project for a clip that came from none", async () => {
    const made = await edited("t3");
    expect(made.projectId).not.toBe(projectId);
    expect(await edited("t3")).toEqual(made);
    const fresh = JSON.parse(readFileSync(path.join(root, "projects", made.projectId, "meta.json"), "utf8")) as { owner: string; clips: unknown[] };
    expect(fresh).toMatchObject({ owner: "owner", name: "clip · edited.mp4" });
    expect(fresh.clips).toHaveLength(1);
  }, 30_000);
});
