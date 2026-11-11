import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthVars } from "./auth";

// The bucket is faked: the relay's "direct" kind talks to whatever serverStore() returns.
const fake = vi.hoisted(() => ({ bucket: null as null | object, store: null as null | Record<string, unknown> }));
vi.mock("./library/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./library/db")>()),
  serverBucket: () => fake.bucket,
  serverStore: () => fake.store,
}));

const dataDir = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "relay-"));
process.env.DATA_DIR = dataDir;
const { readMeta, reviewJobsDone, uploadRelayApp } = await import("./review");
// an upload's processing runs on after its request is answered: the folder goes when that has ended
afterAll(async () => {
  await reviewJobsDone();
  rmSync(dataDir, { recursive: true, force: true });
});

const app = new Hono<{ Variables: AuthVars }>();
app.use("*", async (c, next) => {
  c.set("user", { username: "owner", role: "user", cloud: false, off: [] });
  await next();
});
app.route("/api/uploads/relay", uploadRelayApp);
const RELAY = "/api/uploads/relay";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const read = async (r: Response | Promise<Response>): Promise<any> => (await r).json();
const json = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  delete process.env.CT_UPLOAD_RELAY;
  fake.bucket = null;
  fake.store = null;
});

describe("upload relay: chunked (no bucket)", () => {
  it("the view names chunked as active, with direct not available", async () => {
    const view = await read(app.request(RELAY));
    expect(view.active).toBe("chunked");
    expect(view.relays.find((r: { id: string }) => r.id === "direct").available).toBe(false);
  });

  it("a whole upload through the server: init, one part, complete", async () => {
    const bytes = Buffer.from("tiny video");
    const init = await read(app.request(RELAY, json({ name: "clip.mp4", size: bytes.length })));
    expect(init.relay).toBe("chunked");
    const part = await app.request(`${RELAY}/${init.id}/parts/1`, {
      method: "POST",
      headers: {
        "upload-length": String(bytes.length),
        "upload-part-size": String(init.partSize),
        "content-length": String(bytes.length),
      },
      body: bytes,
    });
    expect(part.status).toBe(200);
    const done = await app.request(`${RELAY}/${init.id}/complete`, { method: "POST" });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { id: string }).id).toBeTruthy();
  });

  it("a video whose processing cannot save its end does not stop the next upload's processing", async () => {
    const upload = async () => {
      const bytes = Buffer.from("not a video");
      const init = await read(app.request(RELAY, json({ name: "clip.mp4", size: bytes.length })));
      await app.request(`${RELAY}/${init.id}/parts/1`, {
        method: "POST",
        headers: { "upload-length": String(bytes.length), "upload-part-size": String(init.partSize), "content-length": String(bytes.length) },
        body: bytes,
      });
      return ((await read(app.request(`${RELAY}/${init.id}/complete`, { method: "POST" }))) as { id: string }).id;
    };
    // the first video's folder cannot be written while its job runs: the job has nowhere to save "error"
    const first = await upload();
    const folder = path.join(dataDir, "review", first);
    chmodSync(folder, 0o555);
    try {
      await reviewJobsDone(); // resolves: the failure stayed with that job
    } finally {
      chmodSync(folder, 0o755);
    }
    expect((await readMeta(first))!.versions[0]!.status).toBe("processing"); // it could not say otherwise
    const second = await upload();
    await reviewJobsDone();
    expect((await readMeta(second))!.versions[0]!.status).toBe("error"); // processed: ffmpeg cannot read it
  });
});

describe("upload relay: direct (server bucket)", () => {
  it("the server picks direct when a bucket is set up, and the browser gets presigned part URLs", async () => {
    const deleted: string[] = [];
    const completed: { key: string; uploadId: string; parts: unknown }[] = [];
    fake.bucket = {};
    fake.store = {
      kind: "s3",
      direct: {
        start: async () => ({ uploadId: "u1", partSize: 6, urls: ["https://bucket.test/p1", "https://bucket.test/p2"] }),
        complete: async (key: string, uploadId: string, parts: unknown) => void completed.push({ key, uploadId, parts }),
        abort: async () => {},
      },
      localCopy: async () => {
        const p = path.join(dataDir, "bucket-copy");
        writeFileSync(p, "hello world"); // 11 bytes, the size the init promised
        return p;
      },
      delete: async (key: string) => void deleted.push(key),
    };

    const view = await read(app.request(RELAY));
    expect(view.active).toBe("direct");

    const init = await read(app.request(RELAY, json({ name: "clip.mp4", size: 11 })));
    expect(init.relay).toBe("direct");
    expect(init.partSize).toBe(6);
    expect(init.urls).toHaveLength(2);

    // parts never come through this server on the direct kind
    const viaServer = await app.request(`${RELAY}/${init.id}/parts/1`, { method: "POST", body: "x" });
    expect(viaServer.status).toBe(409);

    const bad = await app.request(`${RELAY}/${init.id}/complete`, json({ parts: [{ number: 0, etag: "" }] }));
    expect(bad.status).toBe(400);

    const done = await app.request(`${RELAY}/${init.id}/complete`, json({ parts: [{ number: 1, etag: "a" }, { number: 2, etag: "b" }] }));
    expect(done.status).toBe(200);
    expect(completed).toEqual([{ key: `review-uploads/${init.id}/source`, uploadId: "u1", parts: [{ number: 1, etag: "a" }, { number: 2, etag: "b" }] }]);
    expect(deleted).toEqual([`review-uploads/${init.id}/source`]);
    expect(((await done.json()) as { versions: { bytes: number }[] }).versions[0]!.bytes).toBe(11);
  });

  it("a configured chunked relay wins over a bucket", async () => {
    fake.bucket = {};
    fake.store = { kind: "s3", direct: {} };
    process.env.CT_UPLOAD_RELAY = "chunked";
    const view = await read(app.request(RELAY));
    expect(view.active).toBe("chunked");
    const init = await read(app.request(RELAY, json({ name: "clip.mp4", size: 5 })));
    expect(init.relay).toBe("chunked");
  });
});
