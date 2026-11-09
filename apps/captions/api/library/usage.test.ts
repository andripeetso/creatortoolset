import { S3Client, UploadPartCommand } from "@aws-sdk/client-s3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "../auth";
import { memoryS3 } from "./storage/blob-contract";

const dir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "library-usage-"));
process.env.DATA_DIR = path.join(dir, "data");
const { blobs, libraryDb } = await import("./db");
const { libraryApp } = await import("./routes");
const { storageApp } = await import("./usage");
const { watchApp } = await import("./watch");
const { env } = await import("../lib/env");

// every S3 client in the app answers from memory
const s3 = memoryS3();
vi.spyOn(S3Client.prototype, "send").mockImplementation(s3.send as never);

afterAll(() => {
  vi.restoreAllMocks();
  for (const k of ["LIBRARY_S3_BUCKET", "LIBRARY_S3_ACCESS_KEY", "LIBRARY_S3_SECRET_KEY"]) delete process.env[k];
  rmSync(dir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use(async (c, next) => {
  c.set("user", { username: c.req.header("x-user") ?? "", role: "member" } as never);
  return next();
});
app.route("/api/library", libraryApp);
app.route("/api/library", storageApp);
app.route("/api/library", watchApp);

const call = (user: string, method: string, url: string, body?: unknown) =>
  app.request(url, {
    method,
    headers: { "x-user": user, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const today = () => new Date().toISOString().slice(0, 10);
const stored = (lib: string) =>
  (libraryDb().prepare("SELECT stored_bytes FROM usage_daily WHERE library_id = ? ORDER BY day DESC LIMIT 1").get(lib) as { stored_bytes: number } | undefined)
    ?.stored_bytes ?? 0;
const own = { kind: "s3", mode: "own", endpoint: "https://s3.example.com", region: "eu-1", bucket: "tiny-acrobatics", accessKey: "AKIATINYACCESS", secretKey: "tiny-secret-value" };

beforeAll(() => {
  mkdirSync(process.env.DATA_DIR!, { recursive: true });
  libraryDb()
    .prepare("INSERT INTO libraries (id, workspace_id, name, storage_kind, created_at) VALUES ('lib_a', 'owner-a', 'A', 'local', 0), ('lib_b', 'owner-a', 'B', 'local', 1), ('lib_m', 'owner-a', 'M', 'local', 2)")
    .run();
});

describe("library storage choice", () => {
  it("is the owner's: another account gets 404", async () => {
    expect((await call("stranger", "GET", "/api/library/lib_a/usage")).status).toBe(404);
    expect((await call("stranger", "PUT", "/api/library/lib_a/storage", own)).status).toBe(404);
    expect(await (await call("owner-a", "GET", "/api/library/lib_a/usage")).json()).toMatchObject({ kind: "local", keysSet: false, locked: false });
  });

  it("an own bucket is tried with a test file, and its keys never come back", async () => {
    s3.log.length = 0;
    const r = await call("owner-a", "PUT", "/api/library/lib_a/storage", own);
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(JSON.parse(text)).toMatchObject({ kind: "s3", mode: "own", bucket: "tiny-acrobatics", endpoint: "https://s3.example.com", keysSet: true, storedBytes: 0 });
    expect(s3.log).toEqual(["PutObjectCommand", "DeleteObjectCommand"]);
    expect(s3.objects.size).toBe(0);
    const again = await (await call("owner-a", "GET", "/api/library/lib_a/usage")).text();
    const list = await (await call("owner-a", "GET", "/api/library")).text();
    for (const body of [text, again, list]) {
      expect(body).not.toContain(own.secretKey);
      expect(body).not.toContain(own.accessKey);
    }
  });

  it("refuses a private or plain-http endpoint on a production server, and a server bucket that isn't set up", async () => {
    const was = env.isProduction;
    (env as { isProduction: boolean }).isProduction = true;
    try {
      for (const endpoint of ["http://s3.example.com", "https://127.0.0.1:9000", "https://[::1]", "https://10.0.0.5", "https://169.254.169.254", "https://localhost", "https://0x7f000001", "https://[::ffff:7f00:1]"]) {
        const r = await call("owner-a", "PUT", "/api/library/lib_m/storage", { ...own, endpoint });
        expect(r.status, endpoint).toBe(400);
      }
    } finally {
      (env as { isProduction: boolean }).isProduction = was;
    }
    expect((await call("owner-a", "PUT", "/api/library/lib_m/storage", { kind: "s3", mode: "server" })).status).toBe(400);
  });

  it("an upload lands in the bucket, usage counts its bytes, playback is a signed redirect, and where it lives is locked", async () => {
    const data = Buffer.from("tiny acrobatics clip bytes");
    // a bucket library takes the bytes by presigned PUT: the browser's part goes to the bucket, played here
    const init = (await (await call("owner-a", "POST", "/api/library/lib_a/uploads", { filename: "Roll.mp4", size: data.length })).json()) as {
      id: string;
      direct: { urls: string[] };
    };
    const key = `libraries/lib_a/v/${init.id}/source`;
    const uploadId = new URL(init.direct.urls[0]!).searchParams.get("uploadId")!;
    const part = (await new S3Client({ region: "eu-1" }).send(
      new UploadPartCommand({ Bucket: "tiny-acrobatics", Key: key, UploadId: uploadId, PartNumber: 1, Body: data }),
    )) as { ETag: string };
    const done = (await (await call("owner-a", "POST", `/api/library/uploads/${init.id}/finish`, { parts: [{ number: 1, etag: part.ETag }] })).json()) as {
      versionId: string;
    };
    expect(s3.objects.get(key)?.equals(data)).toBe(true);

    const usage = await (await call("owner-a", "GET", "/api/library/lib_a/usage")).json();
    expect(usage).toMatchObject({ storedBytes: data.length, locked: true, days: [{ day: today(), storedBytes: data.length }] });

    const play = await call("owner-a", "GET", `/api/library/media/${done.versionId}/source`);
    expect(play.status).toBe(302);
    const url = new URL(play.headers.get("location")!);
    expect(url.origin).toBe("https://tiny-acrobatics.s3.example.com");
    expect(url.pathname).toBe(`/${key}`);
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");

    expect((await call("owner-a", "PUT", "/api/library/lib_a/storage", { kind: "local" })).status).toBe(409);
    expect((await call("owner-a", "PUT", "/api/library/lib_a/storage", { ...own, bucket: "other-bucket" })).status).toBe(409);
    // new keys for the same bucket are fine, and leaving them out keeps the saved ones
    expect((await call("owner-a", "PUT", "/api/library/lib_a/storage", { ...own, accessKey: "AKIANEWKEY", secretKey: "new-secret" })).status).toBe(200);
    expect(await (await call("owner-a", "PUT", "/api/library/lib_a/storage", { ...own, accessKey: undefined, secretKey: "", region: "eu-2" })).json()).toMatchObject({
      region: "eu-2",
      keysSet: true,
    });
    expect(JSON.parse(libraryDb().prepare("SELECT storage_config AS c FROM libraries WHERE id = 'lib_a'").get()!.c as string)).toMatchObject({ secretKey: "new-secret" });
  });

  it("usage rows match the bytes put and deleted, an overwrite by the difference", async () => {
    const before = stored("lib_a");
    const file = (text: string) => {
      const f = path.join(dir, `f-${Math.random()}`);
      writeFileSync(f, text);
      return f;
    };
    await blobs.put("libraries/lib_a/v/ver_x/thumb.jpg", file("0123456789"));
    expect(stored("lib_a") - before).toBe(10);
    await blobs.put("libraries/lib_a/v/ver_x/thumb.jpg", file("0123"));
    expect(stored("lib_a") - before).toBe(4);
    await blobs.put("libraries/lib_a/v/ver_y/thumb.jpg", file("012345"));
    expect(stored("lib_a") - before).toBe(10);
    await blobs.delete("libraries/lib_a/v/ver_x/thumb.jpg");
    await blobs.delete("libraries/lib_a/v/ver_x/thumb.jpg"); // already gone: nothing more
    expect(stored("lib_a") - before).toBe(6);
    expect(libraryDb().prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE library_id = 'lib_a'").get()).toEqual({ n: 1 }); // one row a day
  });

  it("a server bucket works when the server has one; local libraries write no usage", async () => {
    Object.assign(process.env, { LIBRARY_S3_BUCKET: "tiny-server", LIBRARY_S3_ACCESS_KEY: "server-access", LIBRARY_S3_SECRET_KEY: "server-secret" });
    const r = await call("owner-a", "PUT", "/api/library/lib_m/storage", { kind: "s3", mode: "server" });
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(JSON.parse(body)).toMatchObject({ kind: "s3", mode: "server", serverBucket: true, keysSet: false });
    expect(body).not.toContain("server-secret");

    const f = path.join(dir, "local-file");
    writeFileSync(f, "local");
    await blobs.put("libraries/lib_b/v/ver_l/thumb.jpg", f);
    expect(stored("lib_b")).toBe(0);
  });

  it("a bucket library refuses watch folders that leave files in place, and the other way round", async () => {
    const folder = path.join(dir, "Footage");
    mkdirSync(folder, { recursive: true });
    const ref = await call("owner-a", "PUT", "/api/library/lib_a/watch", { folders: [{ path: folder, mode: "reference" }] });
    expect(ref.status).toBe(400);
    expect((await call("owner-a", "PUT", "/api/library/lib_a/watch", { folders: [{ path: folder, mode: "copy" }] })).status).toBe(200);

    expect((await call("owner-a", "PUT", "/api/library/lib_b/watch", { folders: [{ path: folder, mode: "reference" }] })).status).toBe(200);
    expect((await call("owner-a", "PUT", "/api/library/lib_b/storage", own)).status).toBe(409);
  });
});
