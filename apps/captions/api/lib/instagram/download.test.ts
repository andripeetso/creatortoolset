import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DownloadError,
  assertCdnUrl,
  describeFetchError,
  downloadToFile,
  extensionFor,
  resolveMime,
} from "./download";

const dir = mkdtempSync(path.join(tmpdir(), "ig-dl-"));
const CDN = "https://scontent-lhr8-1.cdninstagram.com/v/t51/01.jpg?x=1";

describe("assertCdnUrl", () => {
  it("accepts Instagram's CDN hosts only, over https", () => {
    expect(assertCdnUrl(CDN).hostname).toBe("scontent-lhr8-1.cdninstagram.com");
    expect(assertCdnUrl("https://instagram.fsjo14-1.fna.fbcdn.net/o1/v/x.mp4").hostname).toContain(
      "fbcdn.net",
    );
    expect(() => assertCdnUrl("http://scontent.cdninstagram.com/x.jpg")).toThrow(DownloadError);
    expect(() => assertCdnUrl("https://evil.example/x.jpg")).toThrow(DownloadError);
    expect(() => assertCdnUrl("https://notcdninstagram.com/x.jpg")).toThrow(DownloadError);
    expect(() => assertCdnUrl("nope")).toThrow(DownloadError);
  });
});

describe("resolveMime / extensionFor", () => {
  it("prefers a real content-type, then the URL extension, then the fallback", () => {
    expect(resolveMime("video/mp4; charset=binary", CDN, "x")).toBe("video/mp4");
    expect(resolveMime("application/octet-stream", CDN, "x")).toBe("image/jpeg");
    expect(resolveMime(null, "https://cdn/x/unknown", "image/jpeg")).toBe("image/jpeg");
    expect(extensionFor("image/webp")).toBe("webp");
    expect(extensionFor("video/x-something")).toBe("mp4");
  });
});

describe("downloadToFile", () => {
  const body = (bytes: number, headers: Record<string, string>) =>
    new Response(new Uint8Array(bytes).fill(7), { status: 200, headers });

  it("streams to a .part file, then renames on success", async () => {
    const dest = path.join(dir, "ok.jpg");
    const seen: number[] = [];
    const fetchImpl = vi.fn(async () =>
      body(4096, { "content-type": "image/jpeg", "content-length": "4096" }),
    );
    const r = await downloadToFile(CDN, dest, {
      maxBytes: 10_000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      onBytes: (n) => seen.push(n),
    });
    expect(r).toEqual({ bytes: 4096, mime: "image/jpeg" });
    expect(statSync(dest).size).toBe(4096);
    expect(existsSync(`${dest}.part`)).toBe(false);
    expect(seen.at(-1)).toBe(4096);
  });

  it("refuses up front when Content-Length is over the cap", async () => {
    const dest = path.join(dir, "big.mp4");
    const fetchImpl = vi.fn(async () =>
      body(10, { "content-type": "video/mp4", "content-length": String(50 * 1024 * 1024) }),
    );
    await expect(
      downloadToFile(CDN, dest, { maxBytes: 1024, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(existsSync(dest)).toBe(false);
  });

  it("aborts mid-stream when the cap is exceeded and removes the partial", async () => {
    const dest = path.join(dir, "overflow.mp4");
    const fetchImpl = vi.fn(async () => body(5000, { "content-type": "video/mp4" }));
    await expect(
      downloadToFile(CDN, dest, { maxBytes: 1000, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(`${dest}.part`)).toBe(false);
  });

  it("explains expired links", async () => {
    const dest = path.join(dir, "gone.jpg");
    const fetchImpl = vi.fn(async () => new Response(null, { status: 403 }));
    await expect(
      downloadToFile(CDN, dest, { maxBytes: 1000, fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/expired/);
  });
});

describe("downloadToFile retries", () => {
  const ok = async () =>
    new Response(new Uint8Array(16), { status: 200, headers: { "content-type": "image/jpeg" } });
  const netFail = () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNRESET"), { code: "ECONNRESET" }) });
  };

  it("retries a network failure and then succeeds", async () => {
    const dest = path.join(dir, "retry.jpg");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementationOnce(netFail).mockImplementationOnce(netFail).mockImplementation(ok);
    const sleeps: number[] = [];
    const out = await downloadToFile(CDN, dest, {
      maxBytes: 1024,
      fetchImpl,
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(out.bytes).toBe(16);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([1000, 3000]);
  });

  it("names the underlying network error when every attempt fails", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(netFail);
    await expect(
      downloadToFile(CDN, path.join(dir, "never.jpg"), { maxBytes: 1024, fetchImpl, retries: 1, sleep: async () => {} }),
    ).rejects.toThrow(/fetch failed \(ECONNRESET\)/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("retries 5xx but not an expired link", async () => {
    const five = vi.fn<typeof fetch>().mockImplementationOnce(async () => new Response("", { status: 503 })).mockImplementation(ok);
    await expect(downloadToFile(CDN, path.join(dir, "503.jpg"), { maxBytes: 1024, fetchImpl: five, sleep: async () => {} })).resolves.toMatchObject({ bytes: 16 });
    const gone = vi.fn<typeof fetch>().mockImplementation(async () => new Response("", { status: 410 }));
    await expect(downloadToFile(CDN, path.join(dir, "410.jpg"), { maxBytes: 1024, fetchImpl: gone, sleep: async () => {} })).rejects.toThrow(/expired/);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("describes undici's hidden cause", () => {
    expect(describeFetchError(new TypeError("fetch failed", { cause: Object.assign(new Error("x"), { code: "ENOTFOUND" }) }))).toBe("fetch failed (ENOTFOUND)");
    expect(describeFetchError(new Error("plain"))).toBe("plain");
  });
});
