import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { blobContract } from "./blob-contract";
import { bunnyBlobs } from "./bunny";

/**
 * The Bunny backend through the same contract as the others, against a local server that answers the storage API's
 * PUT, GET, HEAD and DELETE from memory on a real socket (so fetch's streaming upload is exercised).
 */

const dirs: string[] = [];
const fresh = (label: string) => {
  const d = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), `library-bunny-${label}-`));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ZONE = "tinyacrobatics";
const PASSWORD = "tinyacrobatics-test-key";

let server: Server;
let origin: string;
const files = new Map<string, Buffer>(); // "/zone/path" → bytes

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const p = decodeURIComponent(req.url ?? "");
      if (req.headers.accesskey !== PASSWORD) {
        res.writeHead(401).end("{}");
        return;
      }
      if (req.method === "PUT") {
        files.set(p, Buffer.concat(chunks));
        res.writeHead(201, { "content-type": "application/json" }).end('{"HttpCode":201}');
      } else if (req.method === "HEAD" || req.method === "GET") {
        const body = files.get(p);
        if (!body) return res.writeHead(404).end();
        res.writeHead(200, { "content-length": String(body.length) });
        res.end(req.method === "GET" ? body : undefined);
      } else if (req.method === "DELETE") {
        const had = files.delete(p);
        res.writeHead(had ? 200 : 404, { "content-type": "application/json" }).end("{}");
      } else res.writeHead(405).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server?.close());

const place = () => ({ zone: ZONE, accessKey: PASSWORD, origin });

blobContract("bunny", () => {
  files.clear();
  const dir = fresh("contract");
  return { blobs: bunnyBlobs(place(), path.join(dir, "cache"), { cacheBytes: 1024 ** 3 }), dir };
});

describe("bunny BlobStore", () => {
  it("sends the zone password in the AccessKey header and the file under the zone path", async () => {
    files.clear();
    const dir = fresh("auth");
    const file = path.join(dir, "src.bin");
    writeFileSync(file, "mp4-bytes");
    const bad = bunnyBlobs({ ...place(), accessKey: "wrong" }, path.join(dir, "cache"), { cacheBytes: 0 });
    await expect(bad.put("libraries/lib_1/v/ver_1/proxy.mp4", file)).rejects.toThrow("401");
    const good = bunnyBlobs(place(), path.join(dir, "cache"), { cacheBytes: 0 });
    await good.put("libraries/lib_1/v/ver_1/proxy.mp4", file);
    expect(files.get(`/${ZONE}/libraries/lib_1/v/ver_1/proxy.mp4`)?.toString()).toBe("mp4-bytes");
  });

  it("locate with a pull zone and token key signs path and expiry as Bunny's advanced scheme", async () => {
    files.clear();
    const dir = fresh("signed");
    const blobs = bunnyBlobs({ ...place(), cdnHost: "tinyacrobatics.b-cdn.net", tokenKey: "tk-test" }, path.join(dir, "cache"), { cacheBytes: 0 });
    expect(blobs.caps).toEqual({ signedUrls: true, localPaths: false });
    const at = await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900);
    expect(at.kind).toBe("url");
    const url = new URL((at as { url: string }).url);
    expect(url.origin).toBe("https://tinyacrobatics.b-cdn.net");
    expect(url.pathname).toBe("/libraries/lib_1/v/ver_1/proxy.mp4");
    const expires = Number(url.searchParams.get("expires"));
    expect(expires - Math.floor(Date.now() / 1000)).toBeGreaterThan(890);
    const want = createHmac("sha256", "tk-test").update(`/libraries/lib_1/v/ver_1/proxy.mp4${expires}`).digest("base64url");
    expect(url.searchParams.get("token")).toBe(`HS256-${want}`);
  });

  it("signs exactly as a production Bunny signer does (spaces and accents too)", async () => {
    const blobs = bunnyBlobs({ ...place(), cdnHost: "tinyacrobatics.b-cdn.net", tokenKey: "tk-test" }, path.join(fresh("pinned"), "cache"), { cacheBytes: 0 });
    vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      expect(await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900)).toEqual({
        kind: "url",
        url: "https://tinyacrobatics.b-cdn.net/libraries/lib_1/v/ver_1/proxy.mp4?token=HS256-TPwCKxjbzKlC6q-jaAO-t6uI20KlUDVfrAdrc4WkAeg&expires=1800000900",
      });
      expect(await blobs.locate("libraries/lib 1/v/ünï/thumb.jpg", 900)).toEqual({
        kind: "url",
        url: "https://tinyacrobatics.b-cdn.net/libraries/lib%201/v/%C3%BCn%C3%AF/thumb.jpg?token=HS256-uMgY1d2dH5GjhPdJPK70OrjbJ1m8yMrZIwvKho7gb54&expires=1800000900",
      });
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("a key with no extension, or a download, comes from this server's copy: the pull zone can't set its type or name", async () => {
    files.clear();
    const dir = fresh("unnamed");
    const blobs = bunnyBlobs({ ...place(), cdnHost: "tinyacrobatics.b-cdn.net", tokenKey: "tk-test" }, path.join(dir, "cache"), { cacheBytes: 0 });
    const src = path.join(dir, "src.bin");
    writeFileSync(src, "v");
    await blobs.put("libraries/lib_1/v/ver_1/source", src);
    expect((await blobs.locate("libraries/lib_1/v/ver_1/source", 900, { contentType: "video/mp4" })).kind).toBe("path");
    writeFileSync(src, "v");
    await blobs.put("libraries/lib_1/v/ver_1/proxy.mp4", src);
    expect((await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900, { download: "Roll.mp4" })).kind).toBe("path");
  });

  it("without a pull zone, locate gives a local copy path and signs nothing", async () => {
    files.clear();
    const dir = fresh("unsigned");
    const blobs = bunnyBlobs(place(), path.join(dir, "cache"), { cacheBytes: 0 });
    expect(blobs.caps).toEqual({ signedUrls: false, localPaths: true });
    const src = path.join(dir, "src.bin");
    writeFileSync(src, "v");
    await blobs.put("libraries/lib_1/v/ver_1/proxy.mp4", src);
    expect(await blobs.locate("libraries/lib_1/v/ver_1/proxy.mp4", 900)).toEqual({ kind: "path", path: await blobs.localCopy("libraries/lib_1/v/ver_1/proxy.mp4") });
  });
});
