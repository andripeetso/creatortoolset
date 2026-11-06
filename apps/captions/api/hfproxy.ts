import { Hono } from "hono";
import { createWriteStream, existsSync, statSync, createReadStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Same-origin proxy + disk cache for Hugging Face model files.
 * The browser fetches model weights from /api/hf/<model>/resolve/<rev>/<file>
 * so transcription works even where huggingface.co is unreachable.
 * Tries huggingface.co first, falls back to hf-mirror.com, caches on disk.
 */
export const hfApp = new Hono();

const UPSTREAMS = ["https://huggingface.co", "https://hf-mirror.com"];
const HEADER_TIMEOUT_MS = 30000;
const CACHE_DIR = path.join(tmpdir(), "caption-studio-hf-cache");

// in-flight downloads, deduped by cache path
const inflight = new Map<string, Promise<void>>();

// Remember which upstream works and try it first next time.
let preferredUpstream = 0;

async function downloadToCache(urlPath: string, dest: string): Promise<void> {
  const tmp = dest + ".part";
  await mkdir(path.dirname(dest), { recursive: true });
  let lastErr: unknown = null;
  const order = [
    preferredUpstream,
    ...UPSTREAMS.map((_, i) => i).filter((i) => i !== preferredUpstream),
  ];
  for (const ui of order) {
    const base = UPSTREAMS[ui];
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), HEADER_TIMEOUT_MS);
      const t0 = Date.now();
      try {
        const res = await fetch(base + urlPath, {
          redirect: "follow",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok || !res.body) {
          res.body?.cancel().catch(() => {});
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        await rename(tmp, dest);
        preferredUpstream = ui;
        console.log(`[hf] ${urlPath} <- ${base} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
        return;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("upstream unavailable");
}

async function ensureCached(urlPath: string, dest: string): Promise<void> {
  if (existsSync(dest) && statSync(dest).size > 0) return;
  let p = inflight.get(dest);
  if (!p) {
    p = downloadToCache(urlPath, dest).finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  await p;
}

hfApp.all("/*", async (c) => {
  const sub = c.req.path.replace(/^\/api\/hf/, "");
  if (!sub || sub.includes("..")) {
    return c.json({ error: "bad path" }, 400);
  }
  const dest = path.join(CACHE_DIR, sub);
  try {
    await ensureCached(sub, dest);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : "upstream unavailable" },
      502
    );
  }
  const size = statSync(dest).size;
  const web = Readable.toWeb(createReadStream(dest)) as unknown as ReadableStream;
  const headers = new Headers({
    "Content-Type":
      sub.endsWith(".json")
        ? "application/json"
        : sub.endsWith(".txt")
          ? "text/plain"
          : "application/octet-stream",
    "Content-Length": String(size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
  });
  return new Response(web, { status: 200, headers });
});
