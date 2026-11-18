import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, describe, expect, it, vi } from "vitest";
import { WORK_V, type TaskPackage } from "../contracts/work";
import type { AuthVars } from "./auth";

/**
 * Review frames are computer tasks (local-first P3c): with the server's video work off a comment's frame and a
 * reference's look wait for one of the owner's computers, which makes the same JPEG the server made. The upload
 * transcode is serving (decision 5) and runs on the server whatever the switch says.
 */

const root = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "review-frame-"));
mkdirSync(path.join(root, "data"));
process.env.DATA_DIR = path.join(root, "data");
process.env.APP_SECRET = "review-frame-test-secret";
vi.mock("./plugins.gen", () => ({ serverPlugins: [] }));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const server = (await import("./boot")).default;
const { pairDevice, setDeviceWork } = await import("./lib/devices");
const { CLAIM_POLL } = await import("./work/routes");
const { client } = await import("./work/computer");
const { writeServerWork } = await import("./work/server-work");
const { runTaskJob } = await import("./work/tasks");
const { reviewApp, reviewJobsDone } = await import("./review");
CLAIM_POLL.holdMs = 0;

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "tiny", role: "user", cloud: false, off: [] });
  await next();
});
app.route("/", reviewApp);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const up = async (name: string, bytes: Buffer) => {
  const init = await read(app.request("/uploads", json({ name, size: bytes.length })));
  await app.request(`/uploads/${init.id}/parts/1`, {
    method: "POST",
    headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
    body: bytes,
  });
  const asset = await read(app.request(`/uploads/${init.id}/complete`, { method: "POST" }));
  await reviewJobsDone();
  return { id: asset.id as string, version: (await read(app.request(`/assets/${asset.id}`))).asset.versions[0] };
};

const pc = pairDevice("tiny", "Tiny Mac");
const o = { server: "http://server.test", token: pc.token, beatMs: 20, fetch: (u: string, i?: RequestInit) => Promise.resolve(server.request(u, i)) };
const c = client(o);
const claimAndRun = async () => {
  const t = (await c.post<{ task?: TaskPackage }>("work/claim", { v: WORK_V, steps: [], tasks: ["review-frame"] })).task;
  expect(t).toMatchObject({ task: { kind: "review-frame", actor: "tiny" } });
  return runTaskJob(t!, c, o);
};
const size = (jpeg: Buffer) =>
  spawnSync("ffprobe", ["-v", "error", "-show_entries", "stream=width,height", "-of", "csv=p=0", "pipe:0"], { input: jpeg }).stdout.toString().trim();

describe.skipIf(!hasFfmpeg)("review frames on a computer", () => {
  let asset: { id: string; version: { status: string } };

  it("the upload transcode runs on the server with its video work off: serving", async () => {
    writeServerWork({ on: false });
    // 4:4:4 does not play in a browser: the server makes the proxy
    const src = path.join(root, "tiny-acrobatics.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=2", "-c:v", "libx264", "-pix_fmt", "yuv444p", src]);
    asset = await up("tiny-acrobatics.mp4", readFileSync(src));
    expect(asset.version.status).toBe("ready");
    expect(existsSync(path.join(process.env.DATA_DIR!, "review", asset.id, "v1", "proxy.mp4"))).toBe(true);
  });

  it("a frame waits for one of the owner's computers, which makes it; the server's own run gives the same JPEG", async () => {
    const cm = await read(app.request(`/assets/${asset.id}/comments`, json({
      version: 1, t: 1, text: "This corner", drawing: [{ color: "#ff0000", points: [[0.1, 0.5], [0.9, 0.5]] }],
    })));
    const frame = () => app.request(`/assets/${asset.id}/v/1/frame?c=${cm.id}&w=160`);
    const frames = path.join(process.env.DATA_DIR!, "review", asset.id, "v1", "frames");

    setDeviceWork(pc.device.id, { v: WORK_V, steps: [] }); // no computer runs it yet
    const waiting = await frame();
    expect(waiting.status).toBe(202);
    expect(await waiting.json()).toMatchObject({ waiting: true, line: expect.stringMatching(/^Waits for one of your computers/) });
    expect(existsSync(frames)).toBe(false); // nothing decoded on the server
    expect((await frame()).status).toBe(202); // asked again: the same task, still waiting

    setDeviceWork(pc.device.id, { v: WORK_V, steps: [], tasks: ["review-frame"] });
    expect(await claimAndRun()).toBe("done");
    const made = await frame();
    expect(made.headers.get("content-type")).toBe("image/jpeg");
    const fromComputer = Buffer.from(await made.arrayBuffer());
    expect(size(fromComputer)).toBe("160,90");

    // the same frame made by the server itself (its video work on, no computer)
    rmSync(frames, { recursive: true, force: true });
    setDeviceWork(pc.device.id, { v: WORK_V, steps: [] });
    writeServerWork({ on: true });
    const here = await frame();
    expect(here.status).toBe(200);
    expect(Buffer.from(await here.arrayBuffer())).toEqual(fromComputer);
    writeServerWork({ on: false });
  });

  it("a reference's look waits too, and the computer's is the server's", async () => {
    const clip = path.join(root, "ref.mp4");
    spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
    const attach = () =>
      read(app.request(`/assets/${asset.id}/v/1/refs?name=style.mp4`, { method: "POST", headers: { "content-type": "video/mp4" }, body: readFileSync(clip) }));
    const ref = await attach();
    const look = () => app.request(`/assets/${asset.id}/v/1/refs/${ref.id}/look`);
    const waiting = await look();
    expect(waiting.status).toBe(202);
    expect(await read(waiting)).toMatchObject({ line: expect.stringMatching(/^Waits for one of your computers/) });

    setDeviceWork(pc.device.id, { v: WORK_V, steps: [], tasks: ["review-frame"] });
    expect(await claimAndRun()).toBe("done");
    const fromComputer = Buffer.from(await (await look()).arrayBuffer());
    expect(size(fromComputer)).toBe("480,270"); // 3×3 frames, never enlarged

    setDeviceWork(pc.device.id, { v: WORK_V, steps: [] });
    writeServerWork({ on: true });
    const other = await attach();
    expect(Buffer.from(await (await app.request(`/assets/${asset.id}/v/1/refs/${other.id}/look`)).arrayBuffer())).toEqual(fromComputer);
    writeServerWork({ on: false });
  });
});
