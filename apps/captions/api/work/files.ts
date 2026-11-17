import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, open, readdir, rename } from "node:fs/promises";
import path from "node:path";
import type { WorkFile, WorkPackage } from "../../contracts/work";
import { env } from "../lib/env";
import { partPath, proxiesDir, proxyPath, safeName, sizeOf } from "./cache";

/**
 * Where a step's file comes from on a computer (design 6.1), in this order: a copy already on it (the index's path for
 * it, else the same file under the account's storage folders by quick fingerprint), its proxy in the cache, then the
 * server's proxy downloaded into the cache. Never the original: a step that needs one (post) runs only on a computer
 * that has it. Every file is looked for here before the first byte is downloaded.
 */

const MIB = 1 << 20;

/** SHA-256 over the size as decimal text, the first MiB, and the last MiB when the file is over 2 MiB (the Mac's quickPrint, byte for byte). */
export async function quickPrint(file: string): Promise<string | null> {
  try {
    const h = await open(file);
    try {
      const { size } = await h.stat();
      const hash = createHash("sha256").update(String(size));
      const buf = Buffer.alloc(MIB);
      hash.update(buf.subarray(0, (await h.read(buf, 0, MIB, 0)).bytesRead));
      if (size > 2 * MIB) hash.update(buf.subarray(0, (await h.read(buf, 0, MIB, size - MIB)).bytesRead));
      return hash.digest("hex");
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

/** Where each file was last found by fingerprint: version id → path. */
const foundFile = () => path.join(env.dataDir, "found.json");
function readFound(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(foundFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** A folder's files, listed at most every 10 minutes per worker: a NAS share is slow to walk. */
const LISTED_MS = 10 * 60_000;
/** A folder with more entries than this is not looked through (a whole share by mistake); the miss is logged. */
const LISTED_MAX = 50_000;
const listed = new Map<string, { at: number; files: string[] }>();
async function filesIn(root: string, now = Date.now()): Promise<string[]> {
  const kept = listed.get(root);
  if (kept && now - kept.at < LISTED_MS) return kept.files;
  const all = await readdir(root, { recursive: true, withFileTypes: true }).catch(() => []);
  if (all.length > LISTED_MAX) console.warn(`[work] ${root} holds ${all.length} entries; not looked through for a file`);
  const files = all.length > LISTED_MAX ? [] : all.filter((e) => e.isFile()).map((e) => path.join(e.parentPath, e.name));
  listed.set(root, { at: now, files });
  return files;
}

/**
 * 1a–c: the file itself on this computer: the path the server gives (same size, and the same quick fingerprint when it
 * knows one: a different file of the same size at that path is not it), else a same-named file under the folders whose
 * quick fingerprint matches.
 */
export async function copyHere(f: WorkFile, folders: string[], may: (p: string) => Promise<boolean> = async () => true): Promise<string | null> {
  // `may`: whether this computer may read the file at all (work/library.ts mayReadHere), asked before its first byte
  const same = async (p: string) => sizeOf(p) === f.bytes && (await may(p)) && (!f.quick || (await quickPrint(p)) === f.quick);
  if (f.path && (await same(f.path))) return f.path;
  if (!f.quick) return null;
  const found = readFound();
  if (found[f.id] && (await same(found[f.id]!))) return found[f.id]!;
  const names = new Set([f.path && path.basename(f.path), f.title].filter(Boolean));
  for (const root of folders) {
    // ponytail: a listing of each folder, by name only; a renamed file is found by Locate (phase 5)
    for (const p of await filesIn(root)) {
      if (names.has(path.basename(p)) && (await same(p))) {
        writeFileSync(foundFile(), JSON.stringify({ ...found, [f.id]: p }));
        return p;
      }
    }
  }
  return null;
}

export const needsOriginal = (title: string) => `This step needs the original of ${title} on this computer: open Creator Toolset on the Mac that has it`;

export interface Progress {
  done: number;
  total: number;
  leftS?: number;
}

export interface ResolveOptions {
  folders: string[];
  /** GET the server's proxy of a version (the footage route), with these headers */
  get: (versionId: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;
  signal: AbortSignal;
  /** called as bytes arrive, and once before the first download */
  progress?: (p: Progress) => void;
}

/** Version id → the local file the step reads. Throws with one line when a file can't be had here. */
export async function resolveFiles(pkg: Pick<WorkPackage, "files">, o: ResolveOptions): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const fetch: WorkFile[] = [];
  for (const f of pkg.files) {
    if (!safeName(f.id)) throw new Error(`Not a file id: ${f.id}`);
    const here = await copyHere(f, o.folders);
    if (here) out[f.id] = here;
    else if (f.original) throw new Error(needsOriginal(f.title));
    else if (sizeOf(proxyPath(f.id)) !== null && (!f.proxy?.bytes || sizeOf(proxyPath(f.id)) === f.proxy.bytes)) out[f.id] = proxyPath(f.id);
    else if (!f.proxy) throw new Error(`${f.title} is not on this computer, and the server has no proxy of it`);
    else fetch.push(f);
  }
  if (!fetch.length) return out;

  const total = fetch.reduce((n, f) => n + f.proxy!.bytes, 0);
  let done = fetch.reduce((n, f) => n + Math.min(sizeOf(partPath(f.id)) ?? 0, f.proxy!.bytes), 0);
  // time left from the rate over the last 15 s
  const seen: [number, number][] = [];
  const moved = (n: number) => {
    done += n;
    const now = Date.now();
    seen.push([now, done]);
    while (seen.length > 1 && now - seen[0]![0] > 15_000) seen.shift();
    const [t0, d0] = seen[0]!;
    const rate = now - t0 > 500 ? (done - d0) / ((now - t0) / 1000) : 0;
    o.progress?.({ done, total, ...(rate > 0 ? { leftS: Math.ceil((total - done) / rate) } : {}) });
  };
  o.progress?.({ done, total });
  await mkdir(proxiesDir(), { recursive: true });
  for (const f of fetch) out[f.id] = await downloadProxy(f, o, moved);
  return out;
}

/** Downloads one proxy into the cache, resuming its `.part` with Range. An abort stops it at once and keeps the `.part`. */
async function downloadProxy(f: WorkFile, o: ResolveOptions, moved: (n: number) => void): Promise<string> {
  const part = partPath(f.id);
  const want = f.proxy!.bytes;
  let have = sizeOf(part) ?? 0;
  if (want && have > want) {
    moved(-have);
    have = 0;
  }
  if (!want || have < want) {
    const res = await o.get(f.id, { headers: have ? { range: `bytes=${have}-` } : {}, signal: o.signal });
    if (!res.ok || !res.body) throw new Error(`Could not download the proxy of ${f.title} (${res.status})`);
    const append = res.status === 206;
    if (!append && have) moved(-have); // the server sent it whole: start over
    const h = await open(part, append ? "a" : "w");
    const reader = res.body.getReader();
    const stop = () => void reader.cancel().catch(() => {});
    o.signal.addEventListener("abort", stop, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        o.signal.throwIfAborted();
        await h.write(value);
        moved(value.byteLength);
      }
      o.signal.throwIfAborted();
    } finally {
      o.signal.removeEventListener("abort", stop);
      await h.close();
    }
  }
  if (want && sizeOf(part) !== want) throw new Error(`The proxy of ${f.title} came incomplete`);
  await rename(part, proxyPath(f.id));
  return proxyPath(f.id);
}
