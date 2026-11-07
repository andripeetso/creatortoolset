import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { blobContract } from "./blob-contract";
import { localBlobs } from "./local";

const dirs: string[] = [];
const make = () => {
  const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-blobs-"));
  dirs.push(dir);
  return { blobs: localBlobs(path.join(dir, "blobs")), dir };
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

blobContract("local", make);

describe("local BlobStore", () => {
  it("locate gives a local path for Range streaming", async () => {
    const { blobs, dir } = make();
    const file = path.join(dir, "src.mp4");
    writeFileSync(file, "mp4");
    await blobs.put("libraries/lib_1/v/ver_1/proxy.mp4", file);
    expect(await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900)).toEqual({ kind: "path", path: await blobs.localCopy("libraries/lib_1/v/ver_1/proxy.mp4") });
  });
});
