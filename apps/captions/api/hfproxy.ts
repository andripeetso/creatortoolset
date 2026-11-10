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

// in-flight downloads, deduped by cache path (each settles, never rejects)
const inflight = new Map<string, Promise<void>>();

// Remember which upstream works and try it first next time.
let preferredUpstream = 0;

/** The file from the first upstream that answers (the one that worked last time first). */
async function openUpstream(urlPath: string, method: "GET" | "HEAD" = "GET"): Promise<Response> {
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
      try {
        const res = await fetch(base + urlPath, {
          method,
          redirect: "follow",
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        if (!res.ok || (method === "GET" && !res.body)) {
          res.body?.cancel().catch(() => {});
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        preferredUpstream = ui;
        return res;
      } catch (e) {
        clearTimeout(timer);
        lastErr = e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error("upstream unavailable");
}

const cached = (dest: string) => existsSync(dest) && statSync(dest).size > 0;
const typeOf = (sub: string) => (sub.endsWith(".json") ? "application/json" : sub.endsWith(".txt") ? "text/plain" : "application/octet-stream");

hfApp.all("/*", async (c) => {
  const sub = c.req.path.replace(/^\/api\/hf/, "");
  if (!sub || sub.includes("..")) {
    return c.json({ error: "bad path" }, 400);
  }
  const dest = path.join(CACHE_DIR, sub);
  if (c.req.method !== "GET" && !cached(dest)) {
    // a size probe (HEAD) for a file that is not here yet: the upstream's own answer, and nothing is fetched for it
    // (fetching it here made the real request wait behind a download nobody could watch)
    try {
      const probe = await openUpstream(sub, "HEAD");
      const length = probe.headers.get("content-encoding") ? null : probe.headers.get("content-length");
      return new Response(null, { status: 200, headers: { "Content-Type": typeOf(sub), ...(length ? { "Content-Length": length } : {}) } });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "upstream unavailable" }, 502);
    }
  }
  // another request is fetching this file: its copy serves this one
  while (inflight.has(dest)) await inflight.get(dest);
  if (!cached(dest)) {
    // not here yet: the bytes go to the browser as they arrive (its progress bar moves) and a copy is kept on the way
    let release!: () => void;
    inflight.set(dest, new Promise<void>((r) => (release = () => (inflight.delete(dest), r()))));
    let res: Response;
    try {
      res = await openUpstream(sub);
    } catch (e) {
      release();
      return c.json({ error: e instanceof Error ? e.message : "upstream unavailable" }, 502);
    }
    const [toBrowser, toDisk] = res.body!.tee();
    const tmp = dest + ".part";
    void mkdir(path.dirname(dest), { recursive: true })
      .then(() => pipeline(Readable.fromWeb(toDisk as never), createWriteStream(tmp)))
      .then(() => rename(tmp, dest))
      .catch(() => rm(tmp, { force: true }).catch(() => {}))
      .finally(release);
    const length = res.headers.get("content-encoding") ? null : res.headers.get("content-length");
    const headers = { "Content-Type": typeOf(sub), ...(length ? { "Content-Length": length } : {}), "Access-Control-Allow-Origin": "*" };
    return new Response(toBrowser, { status: 200, headers });
  }
  const size = statSync(dest).size;
  const web = Readable.toWeb(createReadStream(dest)) as unknown as ReadableStream;
  const headers = new Headers({
    "Content-Type": typeOf(sub),
    "Content-Length": String(size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
  });
  return new Response(web, { status: 200, headers });
});
