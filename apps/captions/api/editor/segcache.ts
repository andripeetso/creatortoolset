import { createHash, randomUUID } from "node:crypto";
import { open, readdir, rename, rm, stat, utimes } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { env, serverKind } from "../lib/env";
import { segmentsDir } from "../work/cache";
import { onComputer } from "../work/on-computer";

/**
 * Rendered preview segments kept between renders on the person's own Mac (a computer that runs steps, or the server the
 * Mac app runs): a change to one shot renders that shot again, and every other shot's segment (most of a talking-head
 * render: decoding camera files) comes from here. A segment's name is a hash of its whole encoder command, with each
 * input file read as its size and its first and last MiB (never its mtime: a computer touches its proxies before every
 * step), and the encoder's version (preview.ts): anything that changes its pixels or sound changes its command or its files. On a
 * computer the cache is the account's, beside its proxies (Settings → Storage counts and empties it with them); a hosted
 * server keeps none. Past SEG_LIMIT the segments used longest ago go.
 */

export const SEG_LIMIT = 20e9;
/** Raised when a segment is drawn differently in a way its command does not show. */
const FORMAT = 1;
const MIB = 1 << 20;
/** A segment used this recently is never trimmed: a render still going may be reading it. */
const IN_USE_MS = 3600_000;

/** Where segments are kept here, or null for none. */
export function segDir(): string | null {
  if (onComputer.on) return segmentsDir();
  return serverKind() === "mac" ? path.join(env.dataDir, "render-cache") : null;
}

/** A file as the key knows it (size, first and last MiB), read once per render: `seen`. */
async function ident(file: string, seen: Map<string, string>): Promise<string> {
  const had = seen.get(file);
  if (had) return had;
  const st = await stat(file);
  const fh = await open(file, "r");
  try {
    const h = createHash("sha256");
    for (const at of [0, Math.max(0, st.size - MIB)]) {
      const buf = Buffer.alloc(Math.min(MIB, st.size));
      await fh.read(buf, 0, buf.length, at);
      h.update(buf);
    }
    const id = `${st.size}:${h.digest("hex")}`;
    seen.set(file, id);
    return id;
  } finally {
    await fh.close();
  }
}

/** The segment's key: its command with each of `inputs` (local files it reads) put as what it is, and the encoder's `tool` version. */
export async function segKey(args: string[], inputs: string[], seen: Map<string, string>, tool = ""): Promise<string> {
  const ids = new Map<string, string>();
  for (const f of inputs) ids.set(f, await ident(f, seen));
  const parts = [FORMAT, tool, ...args.map((a) => (ids.has(a) ? `file:${ids.get(a)}` : a))];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * The segment for `args` (an encoder command without its output) from the cache in `dir`, rendered by `make` into the
 * path it is given when it is not there. Answers the file to read.
 */
export async function cachedSegment(dir: string, args: string[], inputs: string[], seen: Map<string, string>, make: (out: string) => Promise<void>, tool = ""): Promise<string> {
  const file = path.join(dir, `${await segKey(args, inputs, seen, tool)}.mov`);
  const now = new Date();
  if (await utimes(file, now, now).then(() => true, () => false)) return file;
  await mkdir(dir, { recursive: true });
  const tmp = `${file}.${randomUUID()}.part`;
  try {
    await make(tmp);
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true });
  }
  return file;
}

/**
 * The segments used longest ago go until the cache is under `limit`; none used in the last hour. A part left by a render
 * that was killed goes once it is an hour old (one being written is younger).
 */
export async function trimSegments(dir: string, limit = SEG_LIMIT, now = Date.now()): Promise<void> {
  const names = await readdir(dir).catch(() => [] as string[]);
  for (const n of names.filter((x) => x.endsWith(".part"))) {
    const st = await stat(path.join(dir, n)).catch(() => null);
    if (st && now - st.mtimeMs > IN_USE_MS) await rm(path.join(dir, n), { force: true });
  }
  const all = (await Promise.all(names.filter((n) => n.endsWith(".mov")).map(async (n) => {
    const st = await stat(path.join(dir, n)).catch(() => null);
    return st && { n, size: st.size, used: st.mtimeMs };
  }))).filter((x) => !!x);
  let total = all.reduce((t, x) => t + x.size, 0);
  for (const x of all.sort((a, b) => a.used - b.used)) {
    if (total <= limit) return;
    if (now - x.used < IN_USE_MS) continue;
    await rm(path.join(dir, x.n), { force: true });
    total -= x.size;
  }
}
