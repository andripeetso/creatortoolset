import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { CleanSource } from "../contracts/clean-workspace";
import {
  CLEAN_PRESETS,
  DEFAULT_EDIT,
  adjustmentsSchema,
  applyCleanPreset,
  cropGeometry,
  editOptionsSchema,
  hasAdjustments,
  type EditMeasurement,
  type EditOptions,
} from "../contracts/clean-edit";
import { metadataItems, probe, videoDimensions } from "./lib/clean-media";

const dataDir = mkdtempSync(path.join(tmpdir(), "clean-edit-test-"));
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
let body: Buffer;
beforeAll(() => {
  if (!hasFfmpeg) return;
  const file = path.join(dataDir, "fixture.mp4");
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=320x180:rate=30:duration=3",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=3",
    "-metadata",
    "title=Private title",
    "-metadata",
    "location=+12.3456+065.4321/",
    "-metadata",
    "creation_time=2024-01-01T12:00:00Z",
    "-metadata:s:v:0",
    "handler_name=Private camera app",
    "-metadata:s:a:0",
    "handler_name=Private microphone",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    "-shortest",
    file,
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
  body = readFileSync(file);
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));
async function upload() {
  const response = await app.request("/sources?name=source.mp4", {
    method: "POST",
    body,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<CleanSource>;
}
const post = (id: string, action: string, payload: unknown) =>
  app.request(`/sources/${id}/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
const files = (id: string) =>
  readdir(path.join(dataDir, "clean", "sources", id));
const draft: EditOptions = {
  ...DEFAULT_EDIT,
  unique: true,
  adjustments: {
    ...DEFAULT_EDIT.adjustments,
    brightness: 1.12,
    contrast: 1.1,
    saturation: 0,
    crop: "9:16",
    rotate: 90,
    flipH: true,
    zoom: 1.2,
    panX: 0.5,
    start: 0.5,
    end: 2.5,
    speed: 1.25,
    mute: true,
  },
};

describe("editor settings", () => {
  it("recognizes parsed defaults as unchanged so metadata-only exports can stream-copy", () => {
    const parsed = editOptionsSchema.parse({ unique: false, adjustments: {} });
    expect(parsed.stripMetadata).toBe(true);
    expect(hasAdjustments(parsed.adjustments)).toBe(false);
    expect(hasAdjustments({ ...parsed.adjustments, speed: 1.01 })).toBe(true);
    expect(
      hasAdjustments({ ...parsed.adjustments, cuts: [{ start: 0, end: 1 }] }),
    ).toBe(true);
  });
  it("rejects non-finite/out-of-range values and rounds crops inside the source", () => {
    expect(
      editOptionsSchema.safeParse({
        ...draft,
        adjustments: { ...draft.adjustments, speed: 20 },
      }).success,
    ).toBe(false);
    expect(
      editOptionsSchema.safeParse({
        ...draft,
        adjustments: { ...draft.adjustments, brightness: "1" },
      }).success,
    ).toBe(false);
    for (const pan of [-1, 0, 1]) {
      const g = cropGeometry(1920, 1080, {
        ...draft.adjustments,
        panX: pan,
        panY: pan,
      });
      expect(g.x + g.width).toBeLessThanOrEqual(1920);
      expect(g.y + g.height).toBeLessThanOrEqual(1080);
      expect(g.width % 2).toBe(0);
      expect(g.outputWidth).toBe(g.height);
    }
  });
  it("serves valid Cleaner presets that keep trim, scenes and sound", async () => {
    const served = (await (
      await app.request("/presets")
    ).json()) as typeof CLEAN_PRESETS;
    expect(served.map((p) => p.name)).toEqual(CLEAN_PRESETS.map((p) => p.name));
    const edit = {
      ...draft.adjustments,
      flipV: true,
      zoom: 1.4,
      cuts: [{ start: 1, end: 2 }],
      volume: 0.5,
    };
    for (const preset of served) {
      const a = applyCleanPreset(edit, preset);
      expect(adjustmentsSchema.parse(a)).toEqual(a);
      expect([a.cuts, a.volume, a.start, a.end]).toEqual([
        edit.cuts,
        0.5,
        edit.start,
        edit.end,
      ]);
      expect(a.flipV).toBe(false);
      expect(a.zoom).toBe(preset.adjustments.zoom ?? 1);
    }
  });
});
describe.skipIf(!hasFfmpeg)("temporary editor rendering", () => {
  it("previews rotated phone clips and the final frame of low-frame-rate videos", async () => {
    const rotated = path.join(dataDir, "rotated.mp4");
    expect(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-display_rotation",
        "90",
        "-i",
        path.join(dataDir, "fixture.mp4"),
        "-c",
        "copy",
        rotated,
      ]).status,
    ).toBe(0);
    const lowRate = path.join(dataDir, "low-rate.mp4");
    expect(
      spawnSync("ffmpeg", [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=160x90:rate=1:duration=3",
        "-c:v",
        "libx264",
        lowRate,
      ]).status,
    ).toBe(0);
    for (const [file, width, height, seconds] of [
      [rotated, 180, 320, 1],
      [lowRate, 160, 90, 2.99],
    ] as const) {
      const response = await app.request("/sources?name=phone.mp4", {
        method: "POST",
        body: readFileSync(file),
      });
      const source = (await response.json()) as CleanSource;
      expect([source.width, source.height]).toEqual([width, height]);
      const preview = await post(source.id, "frame", {
        options: DEFAULT_EDIT,
        seconds,
      });
      expect(preview.status, await preview.clone().text()).toBe(200);
      const png = Buffer.from(await preview.arrayBuffer());
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        width,
        height,
      ]);
    }
  });

  it("renders actual frames and downloads with crop, color, trim, speed and mute without saving versions", async () => {
    const source = await upload();
    const preview = await post(source.id, "frame", {
      options: draft,
      seconds: 1,
    });
    expect(preview.status, await preview.clone().text()).toBe(200);
    expect(preview.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await preview.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(await files(source.id)).toEqual(
      expect.arrayContaining(["original.mp4", "session.json"]),
    );
    expect(
      (await files(source.id)).some((name) => name.startsWith(".edit-")),
    ).toBe(false);

    const exported = await post(source.id, "export", draft);
    expect(exported.status).toBe(200);
    const rendered = Buffer.from(await exported.arrayBuffer());
    const output = path.join(dataDir, "export.mp4");
    await writeFile(output, rendered);
    const info = await probe(output);
    const geometry = cropGeometry(320, 180, draft.adjustments);
    expect(videoDimensions(info)).toEqual({
      width: geometry.outputWidth,
      height: geometry.outputHeight,
    });
    expect(Number(info.format?.duration)).toBeCloseTo(1.6, 1);
    // A sane H.264 level (not 6.2 from a lost frame rate): Photos imports it.
    expect(
      info.streams?.find((s) => s.codec_type === "video")?.level,
    ).toBeLessThanOrEqual(31);
    expect(info.streams?.some((s) => s.codec_type === "audio")).toBe(false);
    expect(info.format?.tags?.title).toBeUndefined();
    await vi.waitFor(async () =>
      expect(
        (await files(source.id)).some((name) => name.startsWith(".edit-")),
      ).toBe(false),
    );
    const restored = (await (
      await app.request(`/sources/${source.id}`)
    ).json()) as CleanSource;
    expect(restored.versions).toEqual([]);
    expect(
      Buffer.from(
        await (await app.request(`/sources/${source.id}/media`)).arrayBuffer(),
      ),
    ).toEqual(body);

    const repeat = Buffer.from(
      await (await post(source.id, "export", draft)).arrayBuffer(),
    );
    expect(createHash("md5").update(repeat).digest("hex")).toBe(
      createHash("md5").update(rendered).digest("hex"),
    );
  }, 30_000);

  it("deletes an export file when the download is cancelled", async () => {
    const source = await upload();
    const response = await post(source.id, "export", draft);
    expect(response.status).toBe(200);
    await response.body?.cancel();
    await vi.waitFor(async () =>
      expect(
        (await files(source.id))
          .filter((name) => name !== "baseline.tmk")
          .sort(),
      ).toEqual(["original.mp4", "session.json"]),
    );
  });

  it("validates trim ranges, ownership and failed-render cleanup while retaining the original", async () => {
    const source = await upload();
    const invalid = await post(source.id, "export", {
      ...draft,
      adjustments: { ...draft.adjustments, start: 4 },
    });
    expect(invalid.status).toBe(400);
    username = "other";
    try {
      for (const action of ["measure", "export", "frame"])
        expect((await post(source.id, action, draft)).status).toBe(404);
    } finally {
      username = "owner";
    }
    vi.stubEnv("FFMPEG_PATH", "/missing/edit-test-ffmpeg");
    try {
      expect((await post(source.id, "export", draft)).status).toBe(500);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(
      (await files(source.id)).filter((name) => name !== "baseline.tmk").sort(),
    ).toEqual(["original.mp4", "session.json"]);
  });

  it("replaces a running preview, skips late requests, and enforces ownership on cancellation", async () => {
    const source = await upload();
    const editing = await import("./lib/clean-edit");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi
      .spyOn(editing, "renderEditFrame")
      .mockImplementationOnce(
        async (_input, _output, _options, _seconds, signal) => {
          entered();
          await new Promise<void>((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(signal!.reason), {
              once: true,
            }),
          );
        },
      );
    const client = "421b7d39-ac96-4024-bfc9-267356f3e14d";
    const request = (revision: number, action = "frame") =>
      app.request(`/sources/${source.id}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Clean-Client": client,
          "X-Clean-Revision": String(revision),
        },
        body:
          action === "frame"
            ? JSON.stringify({ options: draft, seconds: 1 })
            : undefined,
      });
    try {
      const obsolete = request(1);
      await started;
      username = "other";
      expect((await request(1, "draft/cancel")).status).toBe(404);
      username = "owner";
      const latest = await request(2);
      expect((await obsolete).status).toBe(409);
      expect(latest.status).toBe(200);
      expect(
        Buffer.from(await latest.arrayBuffer())
          .subarray(1, 4)
          .toString(),
      ).toBe("PNG");
      expect((await request(1)).status).toBe(409);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(
        (await files(source.id))
          .filter((name) => name !== "baseline.tmk")
          .sort(),
      ).toEqual(["original.mp4", "session.json"]);
      expect((await request(3, "draft/cancel")).status).toBe(204);
      expect((await request(3)).status).toBe(409);
    } finally {
      username = "owner";
      spy.mockRestore();
    }
  });

  it("cancels full fingerprint analysis and removes its temporary encoded video", async () => {
    const source = await upload();
    const fingerprints = await import("./lib/clean-fingerprints");
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const spy = vi
      .spyOn(fingerprints, "measureFingerprints")
      .mockImplementationOnce(async (_before, _after, _alignment, signal) => {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
        throw new Error("Cancelled work must never continue");
      });
    const headers = {
      "Content-Type": "application/json",
      "X-Clean-Client": "421b7d39-ac96-4024-bfc9-267356f3e14d",
      "X-Clean-Revision": "1",
    };
    try {
      const measuring = app.request(`/sources/${source.id}/measure`, {
        method: "POST",
        headers,
        body: JSON.stringify(draft),
      });
      await started;
      expect(
        (
          await app.request(`/sources/${source.id}/draft/cancel`, {
            method: "POST",
            headers,
          })
        ).status,
      ).toBe(204);
      expect((await measuring).status).toBe(409);
      expect(
        (await files(source.id))
          .filter((name) => name !== "baseline.tmk")
          .sort(),
      ).toEqual(["original.mp4", "session.json"]);
      expect(
        (await post(source.id, "frame", { options: draft, seconds: 1 })).status,
      ).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("automatically strips metadata from an edited export even when an old preset disables cleanup", async () => {
    const source = await upload();
    const options = {
      ...DEFAULT_EDIT,
      stripMetadata: false,
      adjustments: {
        ...DEFAULT_EDIT.adjustments,
        speed: 0.5,
        end: 1.5,
        volume: 0.4,
      },
    };
    const response = await post(source.id, "export", options);
    expect(response.status).toBe(200);
    const output = path.join(dataDir, "audio-export.mp4");
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    const info = await probe(output);
    expect(info.streams?.some((s) => s.codec_type === "audio")).toBe(true);
    expect(metadataItems(info)).toEqual([]);
    expect(Number(info.format?.duration)).toBeCloseTo(3, 1);
  }, 30_000);

  it("strips file and track tags from unchanged and reordered exports while preserving the original", async () => {
    const source = await upload();
    const values = source.metadata.map((item) => item.value);
    expect(values).toContain("Private title");
    expect(values).toContain("Private camera app");
    expect(values).toContain("Private microphone");
    expect(source.metadata.some((item) => item.key === "location")).toBe(true);
    expect(source.metadata.some((item) => item.key === "creation_time")).toBe(
      true,
    );
    for (const [name, adjustments] of [
      ["unchanged", DEFAULT_EDIT.adjustments],
      [
        "reordered",
        {
          ...DEFAULT_EDIT.adjustments,
          cuts: [
            { start: 1.5, end: 3 },
            { start: 0, end: 1 },
          ],
        },
      ],
    ] as const) {
      const response = await post(source.id, "export", {
        ...DEFAULT_EDIT,
        stripMetadata: false,
        adjustments,
      });
      expect(response.status).toBe(200);
      const output = path.join(dataDir, `${name}-clean.mp4`);
      await writeFile(output, Buffer.from(await response.arrayBuffer()));
      const info = await probe(output);
      expect(metadataItems(info)).toEqual([]);
      if (name === "unchanged") {
        const videoHash = (file: string) => {
          const hash = spawnSync("ffmpeg", [
            "-v",
            "error",
            "-i",
            file,
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-f",
            "hash",
            "-hash",
            "sha256",
            "-",
          ]);
          expect(hash.status, hash.stderr.toString()).toBe(0);
          return hash.stdout.toString();
        };
        expect(videoHash(output)).toBe(
          videoHash(path.join(dataDir, "fixture.mp4")),
        );
      }
      expect(info.streams?.map((stream) => stream.codec_type)).toEqual([
        "video",
        "audio",
      ]);
    }
    expect(
      Buffer.from(
        await (await app.request(`/sources/${source.id}/media`)).arrayBuffer(),
      ),
    ).toEqual(body);
  });

  it.skipIf(!existsSync(path.resolve("runtime/fingerprints/tmk-hash-video")))(
    "measures the encoded draft, aligns trimmed frames, and removes the temporary video",
    async () => {
      const source = await upload();
      const response = await post(source.id, "measure", {
        ...draft,
        stripMetadata: false,
      });
      expect(response.status).toBe(200);
      const report = (await response.json()) as EditMeasurement;
      expect(report.options).toEqual(draft);
      expect(report.metadata).toEqual([]);
      expect(report.fingerprints.pdq.status).toBe("ok");
      expect(report.fingerprints.tmk.status).toBe("ok");
      if (report.fingerprints.pdq.status === "ok") {
        expect(report.fingerprints.pdq.frames[0].originalSeconds).toBe(0.5);
        expect(report.fingerprints.pdq.frames[0].seconds).toBe(0);
        expect(
          report.fingerprints.pdq.frames.every(
            (frame) => frame.originalSeconds! < 2.5,
          ),
        ).toBe(true);
      }
      expect(
        (await files(source.id))
          .filter((name) => name !== "baseline.tmk")
          .sort(),
      ).toEqual(["original.mp4", "session.json"]);
      const exported = Buffer.from(
        await (await post(source.id, "export", draft)).arrayBuffer(),
      );
      expect(createHash("md5").update(exported).digest("hex")).toBe(report.md5);
    },
    30_000,
  );
});
