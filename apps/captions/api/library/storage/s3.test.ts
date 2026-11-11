import { CreateBucketCommand, S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { blobContract, memoryS3 } from "./blob-contract";
import { s3Blobs, s3Client } from "./s3";

/**
 * The S3 backend through the same contract as the local one: against a local S3 server when one is installed (the
 * `minio` binary on PATH), else against an S3 client whose requests are answered from memory.
 */

const scratch = process.env.CT_SCRATCH_DIR ?? tmpdir();
const dirs: string[] = [];
const fresh = (label: string) => {
  const d = mkdtempSync(path.join(scratch, `library-s3-${label}-`));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const place = { endpoint: "http://127.0.0.1:1", region: "us-east-1", bucket: "tiny-acrobatics", pathStyle: true, accessKey: "test-access", secretKey: "test-secret" };

/** A client whose requests are answered from memory (blob-contract.ts). */
function memoryClient() {
  const client = s3Client(place);
  const m = memoryS3();
  client.send = m.send as never;
  return { client, objects: m.objects, log: m.log };
}

// a local S3 server when one is installed; else the in-memory client
let server: ChildProcess | null = null;
let realClient: S3Client | null = null;
const haveServer = spawnSync("minio", ["--version"]).status === 0;
beforeAll(async () => {
  if (!haveServer) return;
  const port = 19000 + Math.floor(Math.random() * 1000);
  const user = { MINIO_ROOT_USER: "tinyacrobatics", MINIO_ROOT_PASSWORD: "tinyacrobatics-test" };
  server = spawn("minio", ["server", fresh("server"), "--address", `127.0.0.1:${port}`, "--quiet"], { env: { ...process.env, ...user }, stdio: "ignore" });
  realClient = s3Client({ ...place, endpoint: `http://127.0.0.1:${port}`, accessKey: user.MINIO_ROOT_USER, secretKey: user.MINIO_ROOT_PASSWORD });
  for (let t = 0; ; t++) {
    try {
      await realClient.send(new CreateBucketCommand({ Bucket: place.bucket }));
      break;
    } catch (e) {
      if (t > 50) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}, 20_000);
afterAll(() => server?.kill());

blobContract(haveServer ? "s3 (local server)" : "s3 (in-memory client)", () => {
  const dir = fresh("contract");
  const client = realClient ?? memoryClient().client;
  return { blobs: s3Blobs(client, place.bucket, path.join(dir, "cache"), { cacheBytes: 1024 ** 3 }), dir };
});

describe("s3 BlobStore", () => {
  it("locate gives a presigned GET that expires, with the type and download name it was asked for", async () => {
    const { client, log } = memoryClient();
    const blobs = s3Blobs(client, place.bucket, path.join(fresh("sign"), "cache"), { cacheBytes: 1024 });
    const at = await blobs.locate("libraries/lib_1/v/ver_1/source", 900, { contentType: "video/mp4", download: "Roll.mp4" });
    expect(at.kind).toBe("url");
    const url = new URL((at as { url: string }).url);
    expect(url.pathname).toBe("/tiny-acrobatics/libraries/lib_1/v/ver_1/source");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("response-content-type")).toBe("video/mp4");
    expect(url.searchParams.get("response-content-disposition")).toBe(`attachment; filename="Roll.mp4"; filename*=UTF-8''Roll.mp4`);
    expect(log).toEqual([]); // signing is local: no request to the bucket
  });

  it("with no endpoint the bucket is AWS's, by region", async () => {
    const blobs = s3Blobs(s3Client({ ...place, endpoint: "", pathStyle: false, region: "eu-west-1" }), place.bucket, path.join(fresh("aws"), "cache"), { cacheBytes: 1024 });
    const at = (await blobs.locate("libraries/lib_1/v/ver_1/source", 900)) as { url: string };
    expect(new URL(at.url).host).toBe("tiny-acrobatics.s3.eu-west-1.amazonaws.com");
  });

  it("a file bigger than one part goes up in parts and comes back whole", async () => {
    const { client, objects, log } = memoryClient();
    const dir = fresh("parts");
    const blobs = s3Blobs(client, place.bucket, path.join(dir, "cache"), { cacheBytes: 1024, partBytes: 10 });
    const file = path.join(dir, "big.bin");
    writeFileSync(file, "abcdefghij0123456789xyz");
    expect(await blobs.put("libraries/lib_1/v/ver_1/source", file)).toEqual({ bytes: 23 });
    expect(log.filter((c) => c === "UploadPartCommand")).toHaveLength(3);
    expect(objects.get("libraries/lib_1/v/ver_1/source")?.toString()).toBe("abcdefghij0123456789xyz");
  });

  it("a direct upload presigns one PUT per part, and complete joins the parts the bucket stored", async () => {
    const { client, objects, log } = memoryClient();
    const blobs = s3Blobs(client, place.bucket, path.join(fresh("direct"), "cache"), { cacheBytes: 1024, partBytes: 10 });
    const key = "libraries/lib_1/v/ver_1/source";
    const started = await blobs.direct!.start(key, 23, { contentType: "video/mp4" });
    expect(started.partSize).toBe(10);
    expect(started.urls).toHaveLength(3);
    const first = new URL(started.urls[0]!);
    expect(first.pathname).toBe(`/tiny-acrobatics/${key}`);
    expect(first.searchParams.get("uploadId")).toBe(started.uploadId);
    expect(first.searchParams.get("partNumber")).toBe("1");
    expect(new URL(started.urls[2]!).searchParams.get("partNumber")).toBe("3");
    expect(objects.has(key)).toBe(false); // nothing lands until the parts are joined

    // the browser's PUTs, played here against the bucket
    const etags: { number: number; etag: string }[] = [];
    for (const [i, body] of ["abcdefghij", "0123456789", "xyz"].entries()) {
      const r = (await client.send(
        new UploadPartCommand({ Bucket: place.bucket, Key: key, UploadId: started.uploadId, PartNumber: i + 1, Body: Buffer.from(body) }),
      )) as { ETag: string };
      etags.push({ number: i + 1, etag: r.ETag });
    }
    await blobs.direct!.complete(key, started.uploadId, etags);
    expect(log).toContain("CompleteMultipartUploadCommand");
    expect(objects.get(key)?.toString()).toBe("abcdefghij0123456789xyz");
  });

  it("the download cache keeps the newest copies under its cap", async () => {
    const { client } = memoryClient();
    const dir = fresh("cache");
    const cache = path.join(dir, "cache");
    const blobs = s3Blobs(client, place.bucket, cache, { cacheBytes: 25 });
    for (const n of [1, 2, 3]) {
      const file = path.join(dir, `s${n}`);
      writeFileSync(file, "x".repeat(10));
      await blobs.put(`libraries/lib_1/v/ver_${n}/source`, file);
      await blobs.localCopy(`libraries/lib_1/v/ver_${n}/source`);
      await new Promise((r) => setTimeout(r, 15)); // distinct mtimes
    }
    const held = (n: number) => existsSync(path.join(cache, "libraries", "lib_1", "v", `ver_${n}`, "source"));
    expect([held(1), held(2), held(3)]).toEqual([false, true, true]);
  });
});
