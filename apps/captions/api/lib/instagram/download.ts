import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DESKTOP_UA } from "./base";

/**
 * Streamed download of Instagram CDN media to disk. The CDN URLs are
 * signed and public (no cookies needed) but expire within hours. Only
 * Instagram's CDN hosts are allowed, and the byte cap is enforced both
 * from Content-Length and while streaming.
 */

export const CDN_HOST = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

/** HTTP = a status worth retrying (5xx, 429); HTTP_FINAL = a definitive refusal (403/404/410…). */
export type DownloadErrorCode = "BAD_URL" | "TOO_LARGE" | "HTTP" | "HTTP_FINAL" | "CANCELLED" | "FAILED";

export class DownloadError extends Error {
  constructor(
    message: string,
    readonly code: DownloadErrorCode,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export function assertCdnUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new DownloadError("Media URL is not valid", "BAD_URL");
  }
  if (url.protocol !== "https:" || !CDN_HOST.test(url.hostname)) {
    throw new DownloadError(
      `Refusing to download from ${url.hostname}`,
      "BAD_URL",
    );
  }
  return url;
}

const MIME_EXT: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
};

const EXT_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_EXT).map(([m, e]) => [e, m])),
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};

/** Best-effort mime from the response, falling back to the URL's extension. */
export function resolveMime(
  contentType: string | null,
  url: string,
  fallback: string,
): string {
  const ct = (contentType || "").split(";")[0].trim().toLowerCase();
  if (ct && ct !== "application/octet-stream" && MIME_EXT[ct]) return ct;
  const ext = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(new URL(url).pathname)?.[1]?.toLowerCase();
  if (ext && EXT_MIME[ext]) return EXT_MIME[ext];
  return ct || fallback;
}

export function extensionFor(mime: string): string {
  return MIME_EXT[mime] ?? (mime.startsWith("video/") ? "mp4" : "jpg");
}

export interface DownloadOptions {
  maxBytes: number;
  signal?: AbortSignal;
  onBytes?: (bytes: number) => void;
  fetchImpl?: typeof fetch;
  /** Used when the server does not say what the file is. */
  fallbackMime?: string;
  /** Extra attempts after a network failure or a 5xx/429 (default 2). */
  retries?: number;
  /** Test hook. */
  sleep?: (ms: number) => Promise<void>;
}

/** undici hides the real reason ("ECONNRESET", "ENOTFOUND") in `cause`; surface it. */
export function describeFetchError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = (e as { cause?: unknown }).cause;
  const inner =
    cause instanceof Error
      ? (cause as { code?: string }).code || cause.message
      : typeof cause === "string"
        ? cause
        : "";
  return inner && !e.message.includes(inner) ? `${e.message} (${inner})` : e.message;
}

const RETRY_DELAYS_MS = [1000, 3000, 8000];

function retryable(e: unknown): boolean {
  return e instanceof DownloadError && (e.code === "FAILED" || e.code === "HTTP") && !e.message.includes("expired");
}

/**
 * Download `url` to `dest` (written as dest.part, renamed on success),
 * retrying transient failures. Expired links, oversize media, bad URLs
 * and cancellations are not retried.
 */
export async function downloadToFile(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  const retries = Math.max(0, opts.retries ?? 2);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await downloadOnce(url, dest, opts);
    } catch (e) {
      if (attempt >= retries || opts.signal?.aborted || !retryable(e)) throw e;
      await sleep(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]!);
    }
  }
}

export interface DownloadResult {
  bytes: number;
  mime: string;
}

/** One attempt. Throws TOO_LARGE as soon as the cap is exceeded and removes the partial. */
async function downloadOnce(
  url: string,
  dest: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  assertCdnUrl(url);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(url, {
      headers: { "User-Agent": DESKTOP_UA, Accept: "*/*" },
      signal: opts.signal,
    });
  } catch (e) {
    if (opts.signal?.aborted) throw new DownloadError("Cancelled", "CANCELLED");
    throw new DownloadError(`Download failed: ${describeFetchError(e)}`, "FAILED");
  }
  if (!res.ok || !res.body) {
    await res.body?.cancel().catch(() => {});
    throw new DownloadError(
      res.status === 403 || res.status === 410
        ? "The media link expired — retry the post to fetch fresh links"
        : `Media download failed (HTTP ${res.status})`,
      res.status >= 500 || res.status === 429 ? "HTTP" : "HTTP_FINAL",
    );
  }
  const declared = Number(res.headers.get("content-length") || 0);
  if (declared > opts.maxBytes) {
    await res.body.cancel().catch(() => {});
    throw new DownloadError(
      `Media is ${Math.round(declared / 1024 / 1024)} MB, over the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`,
      "TOO_LARGE",
    );
  }
  const mime = resolveMime(
    res.headers.get("content-type"),
    url,
    opts.fallbackMime ?? "application/octet-stream",
  );

  const part = `${dest}.part`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > opts.maxBytes) {
        cb(
          new DownloadError(
            `Media exceeds the ${Math.round(opts.maxBytes / 1024 / 1024)} MB limit`,
            "TOO_LARGE",
          ),
        );
        return;
      }
      opts.onBytes?.(bytes);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(
      Readable.fromWeb(res.body as import("node:stream/web").ReadableStream),
      counter,
      createWriteStream(part, { highWaterMark: 1024 * 1024 }),
      { signal: opts.signal },
    );
    await rename(part, dest);
  } catch (e) {
    await rm(part, { force: true }).catch(() => {});
    if (e instanceof DownloadError) throw e;
    if (opts.signal?.aborted) throw new DownloadError("Cancelled", "CANCELLED");
    throw new DownloadError(`Download failed: ${describeFetchError(e)}`, "FAILED");
  }
  if (!bytes) {
    await rm(dest, { force: true }).catch(() => {});
    throw new DownloadError("Instagram sent an empty file", "FAILED");
  }
  return { bytes, mime };
}
