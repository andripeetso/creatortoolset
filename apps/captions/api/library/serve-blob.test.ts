import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { blobs } from "./db";
import { serveBlob } from "./routes";

const file = path.join(mkdtempSync(path.join(tmpdir(), "ct-serve-blob-")), "thumb.jpg");
writeFileSync(file, "jpeg-bytes");

const app = new Hono();
app.get("/kept", (c) => serveBlob(c, "lib/v1/thumb", "image/jpeg", undefined, "private, max-age=31536000, immutable"));
app.get("/plain", (c) => serveBlob(c, "lib/v1/source", "video/mp4"));

afterEach(() => vi.restoreAllMocks());

describe("serveBlob on a bucket", () => {
  it("sends a picture the browser may keep through this server, with its header, not a redirect", async () => {
    vi.spyOn(blobs, "locate").mockResolvedValue({ kind: "url", url: "https://bucket.example.com/signed" } as never);
    vi.spyOn(blobs, "localCopy").mockResolvedValue(file);
    const res = await app.request("/kept");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("immutable");
    expect(await res.text()).toBe("jpeg-bytes");
  });

  it("still redirects anything else to the signed address", async () => {
    vi.spyOn(blobs, "locate").mockResolvedValue({ kind: "url", url: "https://bucket.example.com/signed" } as never);
    const copy = vi.spyOn(blobs, "localCopy");
    const res = await app.request("/plain", { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://bucket.example.com/signed");
    expect(copy).not.toHaveBeenCalled();
  });
});
