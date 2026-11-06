import type { Context } from "hono";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const RANGE_CAP = 8 * 1024 * 1024;

/** Range-aware file response. An open range (`bytes=0-` on a 20 GB
 *  master) is capped; a closed one is answered exactly, since Apple's
 *  player (the iPhone app, Safari) rejects any other length. */
export async function sendFile(c: Context, p: string, type: string, download?: string) {
  const st = await stat(p).catch(() => null);
  if (!st) return c.json({ error: "Not ready" }, 409);
  const size = st.size;
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
    "Last-Modified": new Date(st.mtimeMs).toUTCString(),
  };
  if (download) {
    headers["Content-Disposition"] = `attachment; filename="${download}"`;
  }
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = !download && /^bytes=(\d*)-(\d*)$/.exec(c.req.header("range") ?? "");
  if (m) {
    if (m[1]) {
      start = Number(m[1]);
      if (m[2]) end = Math.min(Number(m[2]), size - 1);
    } else if (m[2]) {
      start = Math.max(0, size - Number(m[2]));
    }
    if (start >= size || start > end) {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
    }
    if (m[1] && !m[2]) end = Math.min(end, start + RANGE_CAP - 1);
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(end - start + 1);
  return new Response(
    Readable.toWeb(createReadStream(p, { start, end })) as unknown as ReadableStream,
    { status, headers },
  );
}

