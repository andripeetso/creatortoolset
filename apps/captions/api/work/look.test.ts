// Shot descriptions on a Linux computer's worker (work/look.ts) through the real device routes: the computer that connects
// the share a Mac's file is on takes its look when load balancing prefers it, reads the video where it is with the
// server's own picture code, sends the signal and the sheets, and the look lane writes the lines from them. A path the
// server names off the computer's shares is never read.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../ai-complete", async (real) => {
  const m = await real<typeof import("../ai-complete")>();
  return { ...m, aiFor: vi.fn(() => ({ only: ["mac"] })) };
});
vi.mock("../ai-vision", () => ({ completeVisionWithFallback: vi.fn() }));

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
mkdirSync(scratch, { recursive: true });
const dir = mkdtempSync(path.join(scratch, "work-look-"));
process.env.DATA_DIR = path.join(dir, "data");
mkdirSync(process.env.DATA_DIR);
process.env.LIBRARY_SCRATCH_DIR = path.join(dir, "data", "scratch");
process.env.CT_CUT_MODEL = "0";
delete process.env.APP_SECRET;
delete process.env.ANTHROPIC_API_KEY;

const app = (await import("../boot")).default;
const { pairDevice, saveReport, setDeviceKinds, touchDevice } = await import("../lib/devices");
const { libraryDb } = await import("../library/db");
const { enqueueJob } = await import("../library/jobs");
const { tick } = await import("../library/worker");
const { stretchesOf } = await import("../library/stretches");
const { MAC_WAITS } = await import("../library/shots");
const { completeVisionWithFallback } = await import("../ai-vision");
const { client } = await import("./computer");
const { claimLook, readable, Refused } = await import("./look");
const { balanceFile } = await import("../lib/balance");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The NAS share as both computers connect it: the Mac at /Volumes/footage, the Linux box at `share`. */
const share = path.join(dir, "mnt", "footage");
const disk = { name: "footage", path: share, freeGb: 100, network: true as const, fs: "smb" as const, server: "tiny-nas.local", share: "footage" };
const machine = { cpus: 8, memGb: 32, freeGb: 16, load: 0 };

const mac = pairDevice("local", "Tiny's Mac");
const box = pairDevice("local", "Tiny's Linux box");
const c = client({ server: "http://studio.test", token: box.token, fetch: async (url, init) => app.request(url.replace("http://studio.test", ""), init) });
const macClaim = async () =>
  ((await (await app.request("/api/devices/relay/editor/claim", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${mac.token}` }, body: JSON.stringify({ kinds: ["library-look"] }) })).json()) as { job: unknown }).job;

const job = (v: string) => libraryDb().prepare("SELECT state, error FROM jobs WHERE version_id = ? AND kind = 'look'").get(v) as { state: string; error: string | null };
const runLooks = async () => {
  while (await tick(Date.now(), ["look"]));
};

beforeAll(() => {
  mkdirSync(path.join(share, "moo"), { recursive: true });
  // 10 s: a test pattern, then a cut to plain blue
  const lavfi = (src: string) => ["-f", "lavfi", "-i", `${src}${src.endsWith("=") ? "" : ":"}size=320x180:rate=25:duration=5`];
  execFileSync("ffmpeg", ["-v", "error", "-y", ...lavfi("testsrc="), ...lavfi("color=c=blue"), "-filter_complex", "[0:v][1:v]concat=n=2:v=1[v]", "-map", "[v]", path.join(share, "moo", "level-1.mp4")]);
  writeFileSync(path.join(dir, "secret.mov"), "not for the server");
  symlinkSync(path.join(dir, "secret.mov"), path.join(share, "moo", "away.mov"));
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_w', 'local', 'W', 'local', 0)").run();
  saveReport(mac.device.id, { at: Date.now(), drivers: [], homes: [], machine: { ...machine, disks: [{ ...disk, path: "/Volumes/footage" }] } });
  saveReport(box.device.id, { at: Date.now(), drivers: [], homes: [], machine: { ...machine, disks: [disk] } });
  mkdirSync(path.dirname(balanceFile("local")), { recursive: true });
  writeFileSync(balanceFile("local"), JSON.stringify({ on: true, weights: { [box.device.id]: 100, [mac.device.id]: 50 } }));
});

/** A video kept on the Mac on the share (`rel` inside it), described, its look parked for a computer that reaches it. */
async function seed(id: string, rel: string) {
  const d = libraryDb();
  const v = `ver-${id}`;
  d.prepare("INSERT INTO assets (id, library_id, kind, title, current_version_id, created_by, created_at, roll) VALUES (?, 'lib_w', 'video', ?, ?, 'local', 1, 'b')").run(id, `Clip ${id}`, v);
  d.prepare(
    `INSERT INTO asset_versions (id, asset_id, n, source_key, bytes, sha256, probe, state, created_by, created_at, mac_path, mac_device, root, root_rel)
     VALUES (?, ?, 1, ?, 1, ?, ?, 'ready', 'local', 1, ?, ?, 'smb://tiny-nas/footage', ?)`,
  ).run(v, id, `mac:${v}`, `mac:${id}`, JSON.stringify({ duration: 10, vcodec: "h264", width: 320, height: 180, fps: 25, rotation: 0 }), `/Volumes/footage/${rel}`, mac.device.id, rel);
  d.prepare("INSERT INTO descriptions (version_id, source, text, provider, created_at, roll) VALUES (?, 'ai', 'A test pattern.', 'test', 1, 'b')").run(v);
  enqueueJob(d, "lib_w", v, "look", "local");
  await runLooks();
  return v;
}

/** The box is online and takes looks, as its worker's claims leave it. */
const boxSeen = () => {
  touchDevice(box.device.id);
  setDeviceKinds(box.device.id, ["library-look"]);
};

describe("a look on a Linux computer's worker", () => {
  it("goes to the box the balance prefers, which reads the file where it is into the sheets the lane looks at", async () => {
    const v = await seed("ast-w-01", "moo/level-1.mp4");
    expect(job(v)).toMatchObject({ state: "needs_key", error: MAC_WAITS });
    boxSeen();
    // set Less often while the Mac is online and takes looks, the box is not handed it
    const weights = (w: Record<string, number>) => writeFileSync(balanceFile("local"), JSON.stringify({ on: true, weights: w }));
    weights({ [box.device.id]: 25, [mac.device.id]: 50 });
    touchDevice(mac.device.id);
    setDeviceKinds(mac.device.id, ["library-look"]);
    expect(await claimLook(c, [share])).toBe(false);
    // the Mac also has the file, but the box is preferred
    weights({ [box.device.id]: 100, [mac.device.id]: 50 });
    expect(await macClaim()).toBeNull();
    expect(await claimLook(c, [share])).toBe(true);
    expect(job(v).state).toBe("queued"); // its part done: back to the lane
    expect(readdirSync(path.join(dir, "data", "looks"))).toEqual([]);
    const sent: number[] = [];
    vi.mocked(completeVisionWithFallback).mockImplementation((async (_s: string, user: string, images: { jpegBase64: string }[], _x: unknown, parse: (t: string) => unknown) => {
      for (const i of images) expect(Buffer.from(i.jpegBase64, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const tiles = [...user.matchAll(/(\d+) \(\d+:\d\d–\d+:\d\d\)/g)].map((m) => Number(m[1]));
      sent.push(...tiles);
      return { value: parse(JSON.stringify({ shots: tiles.map((n) => ({ n, text: `shot ${n}`, action: 2, clear: true, tags: ["pattern"] })) })), provider: "test" };
    }) as never);
    await runLooks();
    expect(job(v)).toMatchObject({ state: "done", error: null });
    const found = stretchesOf(libraryDb(), v);
    // the cut at 5 s splits it; every stretch has its line and its picture hash
    expect(found.length).toBeGreaterThanOrEqual(2);
    expect(found.some((s) => Math.abs(s.a - 5) < 0.2)).toBe(true);
    expect(found.every((s) => s.text?.startsWith("shot ") && /^[0-9a-f]{16}$/.test(s.ph ?? ""))).toBe(true);
    expect(sent.length).toBe(found.length);
  });

  it("refuses a path off its shares, a link out of them and anything not a video, and says why", async () => {
    expect(() => readable(path.join(dir, "secret.mov"), [share])).toThrow(Refused);
    expect(() => readable(path.join(share, "moo", "away.mov"), [share])).toThrow(/not on a network share/);
    writeFileSync(path.join(share, "notes.txt"), "x");
    expect(() => readable(path.join(share, "notes.txt"), [share])).toThrow(/not a video/);
    mkdirSync(path.join(share, "folder.mp4"));
    expect(() => readable(path.join(share, "folder.mp4"), [share])).toThrow(/not a video/);
    expect(() => readable(path.join(share, "moo", "gone.mp4"), [share])).toThrow(/not on this computer/);
    expect(readable(path.join(share, "moo", "level-1.mp4"), [share])).toBe(path.join(share, "moo", "level-1.mp4"));
    // through the road: the server names the link, the box reads nothing and fails the look with its words
    const v = await seed("ast-w-02", "moo/away.mov");
    boxSeen();
    expect(await claimLook(c, [share])).toBe(true);
    expect(job(v)).toMatchObject({ state: "queued", error: expect.stringMatching(/is not on a network share this computer connects/) });
  });
});
