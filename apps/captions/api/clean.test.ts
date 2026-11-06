import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { FingerprintReport } from "../contracts/clean-fingerprints";

const dataDir = mkdtempSync(path.join(tmpdir(), "clean-"));
process.env.DATA_DIR = dataDir;
const hasFfmpeg = spawnSync("ffmpeg", ["-version"]).status === 0;

const { cleanApp } = await import("./clean");

let username = "owner";
const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username, role: "user", cloud: false, off: [] });
  await next();
});
app.route("/", cleanApp);

describe("clean", () => {
  it.skipIf(!hasFfmpeg)("strips every tag and extra track, keeps rotation, owner-only download", async () => {
    const src = path.join(dataDir, "dirty.mov");
    const srt = path.join(dataDir, "subs.srt");
    writeFileSync(srt, "1\n00:00:00,000 --> 00:00:01,000\nhi\n");
    const plain = path.join(dataDir, "plain.mov");
    spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1",
      "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "mpeg4", "-c:a", "aac", plain,
    ]);
    // rotation only sticks on a stream copy
    spawnSync("ffmpeg", [
      "-v", "error", "-display_rotation", "90", "-i", plain, "-i", srt,
      "-map", "0", "-map", "1", "-c", "copy", "-c:s", "mov_text",
      "-metadata", "com.apple.quicktime.location.ISO6709=+12.3456+065.4321/",
      "-metadata", "com.apple.quicktime.model=iPhone 16 Pro",
      "-metadata", "comment=made with CapCut",
      "-metadata:s:v:0", "handler_name=Core Media Video",
      "-movflags", "use_metadata_tags", src,
    ]);

    const res = await app.request("/?name=IMG_0001.MOV", { method: "POST", body: readFileSync(src) });
    const out = (await res.json()) as { id: string; found: { key: string }[]; left: unknown[] };
    expect(res.status).toBe(200);
    const keys = out.found.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining([
      "com.apple.quicktime.location.ISO6709", "com.apple.quicktime.model", "comment", "handler_name", "track",
    ]));
    expect(out.left).toEqual([]);

    username = "someone-else";
    expect((await app.request(`/${out.id}`)).status).toBe(404);
    username = "owner";
    const dl = await app.request(`/${out.id}`);
    expect(dl.headers.get("content-disposition")).toContain('filename="IMG_0001-clean.mov"');
    const clean = path.join(dataDir, "clean.mov");
    writeFileSync(clean, Buffer.from(await dl.arrayBuffer()));
    const probe = spawnSync("ffprobe", [
      "-v", "error", "-of", "json", "-show_entries", "stream=codec_type:stream_side_data=rotation", clean,
    ]);
    const streams = JSON.parse(probe.stdout.toString()).streams;
    expect(streams.map((s: { codec_type: string }) => s.codec_type)).toEqual(["video", "audio"]);
    expect(Math.abs(streams[0].side_data_list[0].rotation)).toBe(90);
  });

  it.skipIf(!hasFfmpeg)("unique hash: new MD5 every time and the file still plays; MKV cleans too", async () => {
    const mov = path.join(dataDir, "u.mov");
    const mkv = path.join(dataDir, "u.mkv");
    for (const f of [mov, mkv]) {
      spawnSync("ffmpeg", [
        "-v", "error", "-f", "lavfi", "-i", "testsrc=size=160x90:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=duration=1", "-c:v", "mpeg4", "-c:a", "aac",
        "-metadata", "title=Beach day", f,
      ]);
    }
    type Out = { id: string; left: unknown[]; md5: { before: string; after: string } };
    const clean = async (name: string, file: string, query = "") => {
      const r = await app.request(`/?name=${name}${query}`, { method: "POST", body: readFileSync(file) });
      return { status: r.status, out: (await r.json()) as Out };
    };

    const [a, b] = [await clean("a.mov", mov), await clean("a.mov", mov)];
    const [u1, u2] = [await clean("a.mov", mov, "&unique=1"), await clean("a.mov", mov, "&unique=1")];
    expect(a.out.md5.after).toBe(b.out.md5.after); // cleaning alone is deterministic
    expect(new Set([a.out.md5.after, u1.out.md5.after, u2.out.md5.after]).size).toBe(3);
    expect(u1.out.left).toEqual([]);
    const file = path.join(dataDir, "u-clean.mov");
    writeFileSync(file, Buffer.from(await (await app.request(`/${u1.out.id}`)).arrayBuffer()));
    expect(spawnSync("ffmpeg", ["-v", "warning", "-i", file, "-f", "null", "-"]).stderr.toString()).toBe("");

    // Matroska's required "Lavf" muxing app and DURATION tags aren't metadata
    const k = await clean("a.mkv", mkv);
    expect(k.status).toBe(200);
    expect(k.out.left).toEqual([]);
    expect((await clean("a.mkv", mkv, "&unique=1")).status).toBe(400);
  });

  it("refuses non-video files", async () => {
    const res = await app.request("/?name=notes.txt", { method: "POST", body: "hi" });
    expect(res.status).toBe(400);
  });

  it.skipIf(!hasFfmpeg || !existsSync(path.resolve("runtime/fingerprints/tmk-hash-video")))("measures visual fingerprints independently of unique MD5, and preserves downloads when tools are missing", async () => {
    const src = path.join(dataDir, "measured.mp4");
    const fixture = spawnSync("ffmpeg", [
      "-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=15:duration=2",
      "-metadata", "title=private test title", "-c:v", "mpeg4", src,
    ]);
    expect(fixture.status, fixture.stderr?.toString()).toBe(0);
    const body = readFileSync(src);
    const plain = await app.request("/?name=measured.mp4", { method: "POST", body });
    expect(await plain.json()).not.toHaveProperty("fingerprints");
    const response = await app.request("/?name=measured.mp4&unique=1&measure=1", { method: "POST", body });
    expect(response.status).toBe(200);
    const out = await response.json() as { id: string; md5: { before: string; after: string }; fingerprints: FingerprintReport };
    expect(out.md5.before).not.toBe(out.md5.after);
    expect(out.fingerprints.pdq.status).toBe("ok");
    expect(out.fingerprints.tmk.status).toBe("ok");
    if (out.fingerprints.pdq.status === "ok") expect(out.fingerprints.pdq.meanDistance).toBe(0);
    if (out.fingerprints.tmk.status === "ok") expect(out.fingerprints.tmk.level2).toBeCloseTo(1, 5);
    expect((await app.request(`/${out.id}`)).status).toBe(200);
    vi.stubEnv("FINGERPRINT_BIN_DIR", path.join(dataDir, "not-installed"));
    try {
      const missing = await app.request("/?name=measured.mp4&measure=1", { method: "POST", body });
      expect(missing.status).toBe(200);
      const result = await missing.json() as { id: string; fingerprints: FingerprintReport };
      expect(result.fingerprints.pdq.status).toBe("unavailable");
      expect(result.fingerprints.tmk.status).toBe("unavailable");
      expect((await app.request(`/${result.id}`)).status).toBe(200);
    } finally { vi.unstubAllEnvs(); }
  }, 30_000);
});
