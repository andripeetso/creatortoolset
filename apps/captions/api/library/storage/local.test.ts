import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localBlobs } from "./local";

// Contract for any BlobStore (S10 runs the S3 backend through the same checks)
let dir: string;
let root: string;
let n = 0;
const source = (text: string) => {
  const file = path.join(dir, `src-${n++}.bin`);
  writeFileSync(file, text);
  return file;
};

beforeEach(() => {
  dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-blobs-"));
  root = path.join(dir, "blobs");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("local BlobStore", () => {
  it("put stores the file under its key and stat reports its size; a missing key is null", async () => {
    const blobs = localBlobs(root);
    expect(await blobs.stat("libraries/lib_1/v/ver_1/source")).toBeNull();
    const res = await blobs.put("libraries/lib_1/v/ver_1/source", source("hello world"));
    expect(res).toEqual({ bytes: 11 });
    expect(await blobs.stat("libraries/lib_1/v/ver_1/source")).toEqual({ bytes: 11 });
  });

  it("localCopy returns a path to the stored bytes; for a missing key it throws", async () => {
    const blobs = localBlobs(root);
    await blobs.put("libraries/lib_1/v/ver_1/thumb.jpg", source("jpeg-bytes"));
    const p = await blobs.localCopy("libraries/lib_1/v/ver_1/thumb.jpg");
    expect(readFileSync(p, "utf-8")).toBe("jpeg-bytes");
    await expect(blobs.localCopy("libraries/lib_1/v/ver_1/nope")).rejects.toThrow();
  });

  it("locate gives a local path for Range streaming", async () => {
    const blobs = localBlobs(root);
    await blobs.put("libraries/lib_1/v/ver_1/proxy.mp4", source("mp4"));
    expect(await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900)).toEqual({ kind: "path", path: await blobs.localCopy("libraries/lib_1/v/ver_1/proxy.mp4") });
  });

  it("delete removes the blob and a second delete is fine", async () => {
    const blobs = localBlobs(root);
    await blobs.put("libraries/lib_1/v/ver_1/wave.json", source("[]"));
    await blobs.delete("libraries/lib_1/v/ver_1/wave.json");
    expect(await blobs.stat("libraries/lib_1/v/ver_1/wave.json")).toBeNull();
    await expect(blobs.delete("libraries/lib_1/v/ver_1/wave.json")).resolves.toBeUndefined();
  });

  it("refuses keys that leave the blob folder", async () => {
    const blobs = localBlobs(root);
    for (const key of ["../escape", "libraries/../../escape", "/etc/passwd", "a//b", ""]) {
      await expect(blobs.stat(key)).rejects.toThrow("Bad blob key");
    }
  });
});
