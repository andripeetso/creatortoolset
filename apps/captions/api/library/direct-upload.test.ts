import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { memoryS3 } from "./storage/blob-contract";

// a bucket library's uploads go straight to the bucket by presigned PUT; the bucket is mocked in memory
const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-direct-"));
process.env.DATA_DIR = dir;
const { libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { s3Client } = await import("./storage/s3");

const bucketEnv = {
  LIBRARY_S3_BUCKET: "tiny-acrobatics",
  LIBRARY_S3_ACCESS_KEY: "test-access",
  LIBRARY_S3_SECRET_KEY: "test-secret",
  LIBRARY_S3_ENDPOINT: "http://127.0.0.1:1",
  LIBRARY_S3_REGION: "us-east-1",
  LIBRARY_S3_FORCE_PATH_STYLE: "true",
};
const bucket = memoryS3();
// the same bucket as the server's, for the browser's part PUTs (a presigned URL is a plain HTTP PUT in production)
const browser = s3Client({
  endpoint: "http://127.0.0.1:1",
  region: "us-east-1",
  bucket: "tiny-acrobatics",
  pathStyle: true,
  accessKey: "test-access",
  secretKey: "test-secret",
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "user" } as never);
  return next();
});
app.route("/api/library", libraryApp);

const who = { "x-user": "owner-s3" };
const json = { ...who, "content-type": "application/json" };
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();

beforeAll(() => {
  Object.assign(process.env, bucketEnv);
  process.env.LIBRARY_DISK_RESERVE_GB = "0"; // the local case stages a file here; the test disk may be nearly full
  vi.spyOn(S3Client.prototype, "send").mockImplementation(bucket.send as never);
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, storage_config, created_at) VALUES ('lib_s3', 'owner-s3', 'S3', 's3', '{\"mode\":\"server\"}', 0)").run();
  libraryDb().prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_local', 'owner-s3', 'Local', 'local', 0)").run();
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const k of [...Object.keys(bucketEnv), "LIBRARY_DISK_RESERVE_GB"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const start = (libraryId: string, filename: string, size: number) =>
  read(app.request(`/api/library/${libraryId}/uploads`, { method: "POST", headers: json, body: JSON.stringify({ filename, size }) }));

/** The browser's part PUTs to the bucket (presigned URLs from `init`), then finish with the ETags the bucket gave. */
async function sendStraight(init: { id: string; direct: { urls: string[] } }, libraryId: string, data: Buffer) {
  const key = `libraries/${libraryId}/v/${init.id}/source`;
  const parts: { number: number; etag: string }[] = [];
  for (const [i, url] of init.direct.urls.entries()) {
    expect(new URL(url).searchParams.get("partNumber")).toBe(String(i + 1));
    const part = (await browser.send(
      new UploadPartCommand({ Bucket: "tiny-acrobatics", Key: key, UploadId: new URL(url).searchParams.get("uploadId")!, PartNumber: i + 1, Body: data }),
    )) as { ETag: string };
    parts.push({ number: i + 1, etag: part.ETag });
  }
  const done = await read(app.request(`/api/library/uploads/${init.id}/finish`, { method: "POST", headers: json, body: JSON.stringify({ parts }) }));
  return { key, done };
}

describe("library uploads to a bucket by presigned PUT", () => {
  const data = Buffer.from("straight to the bucket");
  let firstAsset: string;

  it("a bucket library hands out presigned part URLs, the bytes land in the bucket, and finish records the version", async () => {
    const init = await start("lib_s3", "Roll.mp4", data.length);
    expect(init.direct.partSize).toBeGreaterThan(data.length);
    const url = new URL(init.direct.urls[0]);
    expect(url.pathname).toBe(`/tiny-acrobatics/libraries/lib_s3/v/${init.id}/source`);
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();

    // the server takes no bytes itself for this upload
    const patch = await app.request(`/api/library/uploads/${init.id}`, {
      method: "PATCH",
      headers: { ...who, "upload-offset": "0", "content-length": String(data.length) },
      body: data as never,
      duplex: "half",
    } as RequestInit);
    expect(patch.status).toBe(409);

    const { key, done } = await sendStraight(init, "lib_s3", data);
    expect(done.duplicateOf).toBeUndefined();
    firstAsset = done.assetId;
    expect(done.versionId).toBe(init.id);
    expect(bucket.objects.get(key)?.toString()).toBe("straight to the bucket");
    expect(libraryDb().prepare("SELECT source_key FROM asset_versions WHERE id = ?").get(init.id)).toEqual({ source_key: key });
    expect(libraryDb().prepare("SELECT stored_bytes FROM usage_daily WHERE library_id = 'lib_s3' ORDER BY day DESC LIMIT 1").get()).toEqual({
      stored_bytes: data.length,
    });
  });

  it("the same bytes again are a duplicate: the new bucket copy is removed and the usage is not counted twice", async () => {
    const { key, done } = await sendStraight(await start("lib_s3", "Again.mp4", data.length), "lib_s3", data);
    expect(done).toEqual({ duplicateOf: firstAsset });
    expect(bucket.objects.has(key)).toBe(false);
    expect(libraryDb().prepare("SELECT stored_bytes FROM usage_daily WHERE library_id = 'lib_s3' ORDER BY day DESC LIMIT 1").get()).toEqual({
      stored_bytes: data.length,
    });
  });

  it("a local library keeps the chunked path: no presigned URLs, bytes sent to the server", async () => {
    const init = await start("lib_local", "Local.mp4", 4);
    expect(init.direct).toBeUndefined();
    expect(init.chunkSize).toBeGreaterThan(0);
  });
});
