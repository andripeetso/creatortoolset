import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { measureFingerprints } from "./lib/clean-fingerprints";
import {
  createCleanCopy,
  md5,
  metadataItems,
  probe,
  TYPES,
} from "./lib/clean-media";
import { cleanWorkspaceApp } from "./clean-workspace";
import { CLEAN_PRESETS } from "../contracts/clean-edit";
export { metadataItems } from "./lib/clean-media";
export type { Item } from "./lib/clean-media";

/**
 * Video Cleaner: what Metadata++ does, on the server. Upload a video, see
 * the metadata in it (GPS, phone make and model, app and software tags,
 * dates, comments, extra data tracks, cover art, chapters) and get it back
 * with all of that gone. Video and audio are stream-copied, never
 * re-encoded; rotation and HDR info are side data, not tags, and survive.
 *
 * Not touched: encoder strings inside the compressed video itself (an x264
 * SEI), which only a re-encode removes.
 *
 * Unique hash (?unique=1, what HashManager does): random padding at the end,
 * so every download has a new MD5/SHA even from the same video. It changes
 * the file's bytes, not the picture: visual matching still sees the same video.
 *
 * For this legacy one-shot endpoint, the upload is deleted once cleaned, the clean file after
 * an hour. Layout: $DATA_DIR/clean/<id>.<ext>
 */
export const cleanApp = new Hono<{ Variables: AuthVars }>();

const CLEAN_DIR = path.join(env.dataDir, "clean");
const KEEP_MS = 3600_000;
// Keep the one-shot API for existing clients; the page uses retained sources.
const done = new Map<string, { owner: string; name: string; file: string }>();
cleanApp.route("/sources", cleanWorkspaceApp);
// Before /:id. The iPhone app shows the same presets as the page.
cleanApp.get("/presets", (c) => c.json(CLEAN_PRESETS));

async function sweep(): Promise<void> {
  await mkdir(CLEAN_DIR, { recursive: true });
  const cutoff = Date.now() - KEEP_MS;
  for (const f of await readdir(CLEAN_DIR)) {
    const p = path.join(CLEAN_DIR, f);
    const st = await stat(p).catch(() => null);
    if (st?.isFile() && st.mtimeMs < cutoff) {
      await rm(p, { force: true });
      done.delete(f.split(".")[0]);
    }
  }
}

/* upload: raw video body → found metadata, clean copy, what's left */
cleanApp.post("/", async (c) => {
  const body = c.req.raw.body;
  if (!body) return c.json({ error: "No file body" }, 400);
  const name = (c.req.query("name") || "video.mp4").slice(0, 120);
  const ext = path.extname(name).slice(1).toLowerCase();
  if (!TYPES[ext])
    return c.json({ error: "Send an MP4, MOV, M4V, MKV or WebM video" }, 400);
  const unique = c.req.query("unique") === "1";
  // ponytail: MKV/WebM padding must sit inside the Segment (patch its size); add when someone needs it
  if (unique && (ext === "mkv" || ext === "webm")) {
    return c.json({ error: "Unique file hash works on MP4, MOV and M4V" }, 400);
  }
  await sweep();
  const id = randomUUID();
  const input = path.join(CLEAN_DIR, `${id}.upload.${ext}`);
  const output = path.join(CLEAN_DIR, `${id}.${ext}`);
  try {
    await pipeline(Readable.fromWeb(body as never), createWriteStream(input));
    const found = metadataItems(await probe(input));
    await createCleanCopy(input, output, { stripMetadata: true, unique });
    const left = metadataItems(await probe(output));
    const [{ size }, before, after] = await Promise.all([
      stat(output),
      md5(input),
      md5(output),
    ]);
    const fingerprints =
      c.req.query("measure") === "1"
        ? await measureFingerprints(input, output)
        : undefined;
    done.set(id, { owner: c.get("user").username, name, file: output });
    return c.json({
      id,
      name,
      bytes: size,
      found,
      left,
      md5: { before, after },
      unique,
      fingerprints,
    });
  } catch (e) {
    await rm(output, { force: true });
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: `Could not clean this video: ${msg}` }, 400);
  } finally {
    await rm(input, { force: true });
  }
});

cleanApp.get("/:id", async (c) => {
  const d = done.get(c.req.param("id"));
  const user = c.get("user");
  const st = d && (await stat(d.file).catch(() => null));
  if (!d || !st || (d.owner !== user.username && user.role !== "admin")) {
    return c.json({ error: "Gone after an hour — clean the video again" }, 404);
  }
  const ext = path.extname(d.file).slice(1);
  const base =
    d.name
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.\- ]+/g, "")
      .trim() || "video";
  return new Response(
    Readable.toWeb(createReadStream(d.file)) as unknown as ReadableStream,
    {
      headers: {
        "Content-Type": TYPES[ext],
        "Content-Length": String(st.size),
        "Content-Disposition": `attachment; filename="${base}-clean.${ext}"`,
      },
    },
  );
});
