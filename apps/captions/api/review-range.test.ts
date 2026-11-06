import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { sendFile } from "./review";

// 10 MB: bigger than the 8 MB cap on open ranges
const size = 10 * 1024 * 1024;
const file = path.join(mkdtempSync(path.join(tmpdir(), "range-")), "v.mp4");
writeFileSync(file, Buffer.alloc(size, 1));
const app = new Hono();
app.get("/v", (c) => sendFile(c, file, "video/mp4"));
const get = (range: string) => app.request("/v", { headers: { Range: range } });

describe("byte ranges for players", () => {
  it("answers a closed range exactly (Apple's player rejects anything shorter)", async () => {
    const res = await get(`bytes=0-${size - 1}`);
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${size - 1}/${size}`);
    expect(res.headers.get("content-length")).toBe(String(size));
  });

  it("still caps an open range, so bytes=0- never streams a whole master", async () => {
    const res = await get("bytes=0-");
    expect(res.headers.get("content-range")).toBe(`bytes 0-${8 * 1024 * 1024 - 1}/${size}`);
  });

  it("answers a suffix range exactly", async () => {
    const res = await get("bytes=-100");
    expect(res.headers.get("content-range")).toBe(`bytes ${size - 100}-${size - 1}/${size}`);
  });
});
