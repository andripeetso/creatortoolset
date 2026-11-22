import { Hono } from "hono";
import { createWriteStream, existsSync, statSync, createReadStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { env } from "./lib/env";

/**
 * Same-origin proxy + disk cache for Hugging Face model files.
 * The browser fetches model weights from /api/hf/<model>/resolve/<rev>/<file>
 * so transcription works even where huggingface.co is unreachable.
 * Tries huggingface.co first, falls back to hf-mirror.com, caches on disk.
 * One copy of a model on this computer: a file the server's own model library already keeps (<data>/models, as
 * lib/device-transcribe.ts modelLibrary fetches it) is served from there, and that library's own fetch
 * (OWN_COPY header) is passed on without a second copy in the temporary folder.
 */
export const OWN_COPY = "x-keeps-own-copy";
export const hfApp = new Hono();

const UPSTREAMS = ["https://huggingface.co", "https://hf-mirror.com"];
const HEADER_TIMEOUT_MS = 30000;
const CACHE_MAX_BYTES = 20 * 1024 ** 3;
const cacheDir = () => path.join(env.dataDir, "hf-cache");

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
/** Where the server's model library keeps `sub` (<model>/resolve/main/<file>), or null for another revision. */
const ownCopy = (sub: string) => {
  const m = sub.match(/^\/(.+?)\/resolve\/main\/(.+)$/);
  return m ? path.join(env.dataDir, "models", m[1]!, m[2]!) : null;
};
const typeOf = (sub: string) => (sub.endsWith(".json") ? "application/json" : sub.endsWith(".txt") ? "text/plain" : "application/octet-stream");

type CacheFile = { file: string; size: number; used: number };
/** Every file under `dir` with its size and last use (mtime: a hit touches it). */
async function cacheFiles(dir: string): Promise<CacheFile[]> {
  const out: CacheFile[] = [];
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const file = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await cacheFiles(file)));
    else {
      const s = await stat(file).catch(() => null);
      if (s) out.push({ file, size: s.size, used: s.mtimeMs });
    }
  }
  return out;
}

/** Removes the least recently used files until the cache is within `max` bytes. A download in progress (.part) counts but is never removed. */
export async function trimCache(dir: string, max = CACHE_MAX_BYTES): Promise<void> {
  const files = await cacheFiles(dir);
  let total = files.reduce((n, f) => n + f.size, 0);
  for (const f of files.filter((f) => !f.file.endsWith(".part")).sort((a, b) => a.used - b.used)) {
    if (total <= max) break;
    await rm(f.file, { force: true });
    total -= f.size;
  }
}

// a download cut off by a restart leaves its .part file behind
void cacheFiles(cacheDir()).then((fs) => Promise.all(fs.filter((f) => f.file.endsWith(".part")).map((f) => rm(f.file, { force: true }))));

hfApp.all("/*", async (c) => {
  const sub = c.req.path.replace(/^\/api\/hf/, "");
  if (!sub || sub.includes("..")) {
    return c.json({ error: "bad path" }, 400);
  }
  const own = ownCopy(sub);
  const dest = own && cached(own) ? own : path.join(cacheDir(), sub);
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
    const length = res.headers.get("content-encoding") ? null : res.headers.get("content-length");
    const headers = { "Content-Type": typeOf(sub), ...(length ? { "Content-Length": length } : {}), "Access-Control-Allow-Origin": "*" };
    if (c.req.header(OWN_COPY)) {
      release();
      // a fresh stream: the server's Response takes its body only from a stream no other Response holds
      return new Response(res.body!.pipeThrough(new TransformStream()), { status: 200, headers });
    }
    const [toBrowser, toDisk] = res.body!.tee();
    const tmp = dest + ".part";
    void mkdir(path.dirname(dest), { recursive: true })
      .then(() => pipeline(Readable.fromWeb(toDisk as never), createWriteStream(tmp)))
      .then(() => rename(tmp, dest))
      .then(() => trimCache(cacheDir()))
      .catch(() => rm(tmp, { force: true }).catch(() => {}))
      .finally(release);
    return new Response(toBrowser, { status: 200, headers });
  }
  const size = statSync(dest).size;
  if (dest !== own) void utimes(dest, new Date(), new Date()).catch(() => {}); // a hit is recent for trimCache
  const web =Readable.toWeb(createReadStream(dest)) as unknown as ReadableStream;
  const headers = new Headers({
    "Content-Type": typeOf(sub),
    "Content-Length": String(size),
    "Cache-Control": "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
  });
  return new Response(web, { status: 200, headers });
});
