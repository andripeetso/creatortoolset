import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// Review's Stop: a version being made playable ends as Stopped, its ffmpeg killed, and its uploaded file stays.
const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-stop-"));
process.env.DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

// while held, every ffmpeg Review starts is a process that waits until it is killed
const SLEEP = path.join(dataDir, "sleep.sh");
writeFileSync(SLEEP, "#!/bin/sh\nexec sleep 60\n");
let hold = false;
vi.mock("./ffmpeg-runtime", async (real) => {
  const actual = await real<typeof import("./ffmpeg-runtime")>();
  return { ...actual, ffmpegCommand: () => (hold ? SLEEP : actual.ffmpegCommand()) };
});
const { ffmpegCommand } = await import("./ffmpeg-runtime");
const { reviewApp, addVersion, reviewJobsDone, sourcePath } = await import("./review");
const { inRequestWorkspace } = await import("./lib/workspace-scope");

const WS = "eeeeeeee-0000-4000-8000-0000000000c1";
mkdirSync(path.join(dataDir, "workshop", "projects"), { recursive: true });
writeFileSync(path.join(dataDir, "workshop", "projects", `${WS}.json`), JSON.stringify({ id: WS, owner: "ana", name: "Tiny Acrobatics", createdAt: 1, updatedAt: 1 }));

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: c.req.header("x-as") ?? "ana", role: "user", cloud: false, off: [] });
  await next();
});
app.use("*", inRequestWorkspace);
app.route("/", reviewApp);

// a second of video a browser can't play as it is (MPEG-4 Part 2 in AVI), so Review makes a proxy of it
const clip = path.join(dataDir, "cut.avi");
execFileSync(ffmpegCommand(), ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=160x120", "-c:v", "mpeg4", clip]);
chmodSync(SLEEP, 0o755);

it("stops a version being processed: Stopped, its file kept, and the killed run writes nothing after", async () => {
  hold = true;
  const added = await addVersion(undefined, { owner: "ana", name: "Cut.avi", mime: "video/x-msvideo", bytes: 1, workspace: WS }, async (dest) => execFileSync("cp", [clip, dest]));
  const id = added!.meta.id;
  const version = async () => (await (await app.request(`/assets/${id}`)).json()).asset.versions[0];
  expect((await version()).status).toBe("processing");
  expect((await app.request(`/${id}/stop`, { method: "POST", headers: { "x-as": "bo" } })).status).toBe(404);
  expect(await (await app.request(`/${id}/stop`, { method: "POST" })).json()).toEqual({ ok: true });
  await reviewJobsDone();
  hold = false;
  expect(await version()).toMatchObject({ status: "error", error: "Stopped" });
  expect(existsSync(sourcePath(id, (await version()).n))).toBe(true);
  expect((await app.request(`/${id}/stop`, { method: "POST" })).status).toBe(200);
}, 30_000);

it("Retry prepares a stopped version again, to ready", async () => {
  hold = true;
  const added = await addVersion(undefined, { owner: "ana", name: "Again.avi", mime: "video/x-msvideo", bytes: 1, workspace: WS }, async (dest) => execFileSync("cp", [clip, dest]));
  const id = added!.meta.id;
  const version = async () => (await (await app.request(`/assets/${id}`)).json()).asset.versions[0];
  await app.request(`/${id}/stop`, { method: "POST" });
  await reviewJobsDone();
  hold = false;
  expect((await app.request(`/${id}/retry`, { method: "POST", headers: { "x-as": "bo" } })).status).toBe(404);
  expect(await (await app.request(`/${id}/retry`, { method: "POST" })).json()).toEqual({ ok: true });
  expect((await version()).status).toBe("processing");
  await reviewJobsDone();
  const ready = await version();
  expect(ready.status).toBe("ready");
  expect(ready.error).toBeUndefined();
}, 30_000);

it("a Stop while the upload is still being copied in holds: the run that follows the copy writes nothing", async () => {
  let land!: () => void;
  const copied = new Promise<void>((done) => (land = done));
  const adding = addVersion(undefined, { owner: "ana", name: "Slow.avi", mime: "video/x-msvideo", bytes: 1, workspace: WS }, async (dest) => {
    await copied;
    execFileSync("cp", [clip, dest]);
  });
  let id = "";
  for (let i = 0; i < 50 && !id; i++) {
    await new Promise((r) => setTimeout(r, 20));
    const list = (await (await app.request("/")).json()) as { id: string; name: string }[];
    id = list.find((a) => a.name.startsWith("Slow"))?.id ?? "";
  }
  expect(id).not.toBe("");
  await app.request(`/${id}/stop`, { method: "POST" });
  land();
  await adding;
  await reviewJobsDone();
  expect((await (await app.request(`/assets/${id}`)).json()).asset.versions[0]).toMatchObject({ status: "error", error: "Stopped" });
}, 30_000);
