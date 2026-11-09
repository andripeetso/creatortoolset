import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { Readable } from "node:stream";
import { crc32 } from "node:zlib";
import { mkdtempSync, readFileSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";
import type { CleanSource } from "../contracts/clean-workspace";
import type { CleanBatch } from "../contracts/clean-batch";
import { DEFAULT_EDIT, type EditAudit } from "../contracts/clean-edit";
import { FULL_CLEANUP } from "../contracts/clean-inspection";
import { metadataItems, probe, run } from "./lib/clean-media";
import * as editing from "./lib/clean-edit";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    createReadStream: (...args: Parameters<typeof actual.createReadStream>) =>
      actual.createReadStream(...args),
  };
});

const dataDir = mkdtempSync(path.join(tmpdir(), "clean-privacy-test-"));
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
const post = (url: string, data: unknown) =>
  app.request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
function packet(uuid: string, text: string) {
  const buffer = Buffer.alloc(24 + Buffer.byteLength(text));
  buffer.writeUInt32BE(buffer.length);
  buffer.write("uuid", 4);
  Buffer.from(uuid, "hex").copy(buffer, 8);
  buffer.write(text, 24);
  return buffer;
}
beforeAll(() => {
  if (!hasFfmpeg) return;
  const file = path.join(dataDir, "fixture.mp4");
  const result = spawnSync("ffmpeg", [
    "-v",
    "error",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=160x90:rate=15:duration=1",
    "-metadata",
    "artist=Retained author",
    "-metadata",
    "title=Retained title",
    "-metadata",
    "location=+12.3456+065.4321/",
    "-metadata",
    "creation_time=2024-01-01T12:00:00Z",
    "-c:v",
    "libx264",
    file,
  ]);
  expect(result.status, result.stderr.toString()).toBe(0);
  body = Buffer.concat([
    readFileSync(file),
    packet(
      "be7acfcb97a942e89c71999491e3afac",
      '<x:xmpmeta xmlns:x="urn:tiny:xmpmeta">private-xmp-secret</x:xmpmeta>',
    ),
    packet("d8fec3d61b0e483c92975828877ec481", "synthetic-c2pa-presence-only"),
  ]);
});
afterAll(() => rm(dataDir, { recursive: true, force: true }));
async function upload(name = "source.mp4") {
  const response = await app.request(
    `/sources?name=${encodeURIComponent(name)}`,
    { method: "POST", body },
  );
  expect(response.status).toBe(201);
  return response.json() as Promise<CleanSource>;
}
async function settled(id: string) {
  let job!: CleanBatch;
  await vi.waitFor(
    async () => {
      const response = await app.request(`/sources/batch/${id}`);
      expect(response.status).toBe(200);
      job = (await response.json()) as CleanBatch;
      expect(["ready", "failed", "cancelled"]).toContain(job.state);
    },
    { timeout: 15_000, interval: 50 },
  );
  return job;
}
// Independent reader for these small, stored ZIP fixtures, including central-directory CRC validation.
function zipEntries(zip: Buffer) {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(end).toBeGreaterThan(0);
  const files = new Map<string, Buffer>();
  let offset = zip.readUInt32LE(end + 16);
  for (let i = 0; i < zip.readUInt16LE(end + 10); i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    expect(zip.readUInt16LE(offset + 10)).toBe(0);
    const size = zip.readUInt32LE(offset + 20),
      local = zip.readUInt32LE(offset + 42);
    const length = zip.readUInt16LE(offset + 28),
      extra = zip.readUInt16LE(offset + 30),
      comment = zip.readUInt16LE(offset + 32);
    const name = zip.toString("utf8", offset + 46, offset + 46 + length);
    expect(zip.readUInt32LE(local)).toBe(0x04034b50);
    const start =
      local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const bytes = zip.subarray(start, start + size);
    expect(crc32(bytes)).toBe(zip.readUInt32LE(offset + 16));
    files.set(name, bytes);
    offset += 46 + length + extra + comment;
  }
  return files;
}

describe.skipIf(!hasFfmpeg)("deep privacy cleanup and batch export", () => {
  it("inspects the original immediately and audits selective cleanup without fingerprint work or saved versions", async () => {
    const source = await upload();
    expect(source.inspection?.embedded.status).toBe("checked");
    expect(source.inspection?.embedded.findings.map((f) => f.kind)).toEqual([
      "xmp",
      "c2pa",
    ]);
    const options = {
      ...DEFAULT_EDIT,
      cleanup: { ...FULL_CLEANUP, credits: false, description: false },
    };
    const response = await post(`/sources/${source.id}/audit`, options);
    expect(response.status, await response.clone().text()).toBe(200);
    const report = (await response.json()) as EditAudit;
    for (const category of ["location", "dates", "xmp", "c2pa"])
      expect(
        report.audit.rows.find((r) => r.category === category)?.status,
      ).toBe("removed");
    for (const category of ["credits", "description"])
      expect(
        report.audit.rows.find((r) => r.category === category)?.status,
      ).toBe("kept");
    expect(report).not.toHaveProperty("fingerprints");
    expect(JSON.stringify(report)).not.toContain("private-xmp-secret");
    expect(JSON.stringify(report)).not.toContain("+12.3456");
    expect(
      (await readdir(path.join(dataDir, "clean", "sources", source.id))).sort(),
    ).toEqual(["original.mp4", "session.json"]);
    const output = path.join(dataDir, "kept.mp4");
    await writeFile(
      output,
      Buffer.from(
        await (
          await post(`/sources/${source.id}/export`, options)
        ).arrayBuffer(),
      ),
    );
    const info = await probe(output);
    expect(info.format?.tags?.artist).toBe("Retained author");
    expect(info.format?.tags?.title).toBe("Retained title");
    expect(
      metadataItems(info).some((i) => /location|creation_time/.test(i.key)),
    ).toBe(false);
    const videoHash = (file: string) =>
      run("ffmpeg", [
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
        "md5",
        "-",
      ]);
    expect(await videoHash(output)).toBe(
      await videoHash(
        path.join(dataDir, "clean", "sources", source.id, "original.mp4"),
      ),
    );
    expect(
      Buffer.from(
        await (await app.request(`/sources/${source.id}/media`)).arrayBuffer(),
      ),
    ).toEqual(body);
  });
  it("exports MOV camera codecs through the compatible MP4 encoding path", async () => {
    const mov = path.join(dataDir, "camera.mov");
    await run("ffmpeg", [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x96:rate=15:duration=1",
      "-c:v",
      "prores_ks",
      "-profile:v",
      "2",
      "-pix_fmt",
      "yuv422p10le",
      mov,
    ]);
    const source = (await (
      await app.request("/sources?name=camera.mov", {
        method: "POST",
        body: await readFile(mov),
      })
    ).json()) as CleanSource;
    const response = await post(`/sources/${source.id}/export`, DEFAULT_EDIT);
    expect(response.status, await response.clone().text()).toBe(200);
    const output = path.join(dataDir, "camera-export.mp4");
    await writeFile(output, Buffer.from(await response.arrayBuffer()));
    expect(
      (await probe(output)).streams?.some((s) => s.codec_type === "video"),
    ).toBe(true);
  });
  it("packages distinct names, edited outputs and value-free audits; cleans temporary copies and enforces ownership", async () => {
    const sources = [await upload("../same.mp4"), await upload("../same.mp4")];
    const request = {
      items: sources.map((s, i) => ({
        sourceId: s.id,
        options: {
          ...DEFAULT_EDIT,
          cleanup: { ...FULL_CLEANUP, credits: false },
          adjustments: { ...DEFAULT_EDIT.adjustments, brightness: i ? 1.1 : 1 },
        },
      })),
    };
    const response = await post("/sources/batch", request);
    expect(response.status, await response.clone().text()).toBe(202);
    const { id } = (await response.json()) as CleanBatch;
    username = "other";
    try {
      for (const [url, method] of [
        [`/sources/batch/${id}`, "GET"],
        [`/sources/batch/${id}/download`, "GET"],
        [`/sources/batch/${id}`, "DELETE"],
      ])
        expect((await app.request(url, { method })).status).toBe(404);
      expect(await (await app.request("/sources/batch")).json()).toBeNull();
      expect((await post("/sources/batch", request)).status).toBe(404);
    } finally {
      username = "owner";
    }
    const job = await settled(id);
    expect(job.state, job.error).toBe("ready");
    expect(job.results).toHaveLength(2);
    expect(await readdir(path.join(dataDir, "clean", "batches", id))).toEqual([
      "videos.zip",
    ]);
    const download = await app.request(`/sources/batch/${id}/download`);
    expect(download.headers.get("content-type")).toBe("application/zip");
    const files = zipEntries(Buffer.from(await download.arrayBuffer()));
    expect([...files.keys()]).toEqual([
      "01-same-clean.mp4",
      "02-same-clean.mp4",
      "cleanup-report.json",
    ]);
    const report = files.get("cleanup-report.json")!.toString();
    expect(report).not.toContain("+12.3456");
    expect(report).not.toContain("private-xmp-secret");
    for (const [i, result] of job.results.entries()) {
      expect(result.audit.rows.find((r) => r.category === "c2pa")?.status).toBe(
        "removed",
      );
      expect(
        result.audit.rows.find((r) => r.category === "credits")?.status,
      ).toBe("kept");
      const file = path.join(dataDir, `batch-${i}.mp4`);
      await writeFile(file, files.get(result.filename)!);
      expect((await probe(file)).format?.tags?.artist).toBe("Retained author");
    }
    await vi.waitFor(async () =>
      expect(
        (await app.request(`/sources/batch/${id}`, { method: "DELETE" }))
          .status,
      ).toBe(200),
    );
    expect((await app.request(`/sources/batch/${id}`)).status).toBe(404);
    expect(await readdir(path.join(dataDir, "clean", "batches"))).toEqual([]);
    for (const source of sources)
      expect(
        await readFile(
          path.join(dataDir, "clean", "sources", source.id, "original.mp4"),
        ),
      ).toEqual(body);
  });
  it("cancels active work, holds source locks until cancellation finishes, and removes failed-job files", async () => {
    const source = await upload();
    let entered!: () => void;
    const began = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const render = vi
      .spyOn(editing, "renderEdit")
      .mockImplementationOnce(async (_input, output, _options, signal) => {
        await writeFile(output, "partial");
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(signal!.reason), {
            once: true,
          }),
        );
      });
    try {
      const response = await post("/sources/batch", {
        items: [{ sourceId: source.id, options: DEFAULT_EDIT }],
      });
      expect(response.status).toBe(202);
      const { id } = (await response.json()) as CleanBatch;
      await began;
      expect(
        (await app.request(`/sources/${source.id}`, { method: "DELETE" }))
          .status,
      ).toBe(409);
      expect(
        (
          await post("/sources/batch", {
            items: [{ sourceId: source.id, options: DEFAULT_EDIT }],
          })
        ).status,
      ).toBe(409);
      expect(
        (await app.request(`/sources/batch/${id}`, { method: "DELETE" }))
          .status,
      ).toBe(200);
      expect(await readdir(path.join(dataDir, "clean", "batches"))).toEqual([]);
      expect((await app.request(`/sources/${source.id}`)).status).toBe(200);
    } finally {
      render.mockRestore();
    }
    const failure = vi
      .spyOn(editing, "renderEdit")
      .mockRejectedValueOnce(new Error("Synthetic render failure"));
    try {
      const response = await post("/sources/batch", {
        items: [{ sourceId: source.id, options: DEFAULT_EDIT }],
      });
      const { id } = (await response.json()) as CleanBatch;
      expect((await settled(id)).state).toBe("failed");
      expect(await readdir(path.join(dataDir, "clean", "batches"))).toEqual([]);
      await app.request(`/sources/batch/${id}`, { method: "DELETE" });
      expect(
        (await app.request(`/sources/${source.id}`, { method: "DELETE" }))
          .status,
      ).toBe(200);
    } finally {
      failure.mockRestore();
    }
  });
  it("handles a ZIP input read error without leaking files or source locks", async () => {
    const source = await upload();
    const createReadStream = fs.createReadStream;
    const read = vi
      .spyOn(fs, "createReadStream")
      .mockImplementation((file, options) => {
        if (
          String(file).includes("/batches/") &&
          String(file).endsWith("-clean.mp4")
        )
          return new Readable({
            read() {
              this.destroy(new Error("Synthetic ZIP input failure"));
            },
          }) as fs.ReadStream;
        return createReadStream(file, options);
      });
    try {
      const { id } = (await (
        await post("/sources/batch", {
          items: [{ sourceId: source.id, options: DEFAULT_EDIT }],
        })
      ).json()) as CleanBatch;
      const failed = await settled(id);
      expect(failed.state).toBe("failed");
      expect(failed.error).toBe("Synthetic ZIP input failure");
      expect(await readdir(path.join(dataDir, "clean", "batches"))).toEqual([]);
      expect(
        (await app.request(`/sources/${source.id}`, { method: "DELETE" }))
          .status,
      ).toBe(200);
      await app.request(`/sources/batch/${id}`, { method: "DELETE" });
    } finally {
      read.mockRestore();
    }
  });
  it("rejects duplicate sources and expires undownloaded ZIPs", async () => {
    const source = await upload(),
      item = { sourceId: source.id, options: DEFAULT_EDIT };
    expect((await post("/sources/batch", { items: [item, item] })).status).toBe(
      400,
    );
    expect((await post("/sources/batch", { items: [] })).status).toBe(400);
    const { id } = (await (
      await post("/sources/batch", { items: [item] })
    ).json()) as CleanBatch;
    const ready = await settled(id);
    const time = vi.spyOn(Date, "now").mockReturnValue(ready.expiresAt + 1);
    try {
      expect((await app.request(`/sources/batch/${id}/download`)).status).toBe(
        410,
      );
      expect(await (await app.request("/sources/batch")).json()).toBeNull();
      expect(await readdir(path.join(dataDir, "clean", "batches"))).toEqual([]);
    } finally {
      time.mockRestore();
    }
  });
});
