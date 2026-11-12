import { Hono } from "hono";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { EMPTIED, KEPT_KINDS, type KeptKind, type KeptRow, type KeptView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import { removeFile } from "./assistant-files";
import { EXPORTS_KEEP_DAYS, finishedExportDirs, removeFinishedExports } from "./exports";
import { env } from "./lib/env";
import type { SessionUser } from "./users";

/**
 * Settings → Storage, "Kept on the server" (contracts/storage.ts KEPT_KINDS), mounted at /api/devices/storage/kept:
 *   GET  /              → KeptView: this account's files in the server's data folder, by kind (size and count)
 *   POST /:kind/empty   → deletes this account's files of one EMPTIED kind (a chat's pictures and videos, finished renders)
 * Only the caller's own files: a kind's folder is fixed here, never sent by the client. A file with no owner (made before
 * accounts) counts as an admin's, as the admin panel does.
 *
 * ponytail: sizes are read from disk on every request (one stat per file). Fine for thousands of posts; a cached total
 * per account if a server holds far more.
 */

export const keptApp = new Hono<{ Variables: AuthVars }>();

/** Total size of a folder tree, or of one file. */
export async function dirBytes(p: string): Promise<number> {
  const st = await stat(p).catch(() => null);
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  let total = 0;
  for (const name of await readdir(p).catch(() => [] as string[])) total += await dirBytes(path.join(p, name));
  return total;
}

const at = (...p: string[]) => path.join(env.dataDir, ...p);
const isMine = (owner: unknown, u: SessionUser) => owner === u.username || (!owner && u.role === "admin");

/** The items of a kind that belong to `u`: each one's paths on disk. */
async function itemsOf(kind: KeptKind, u: SessionUser): Promise<string[][]> {
  // `<root>/<id>/<meta>` stores whose meta names the owner
  const owned = async (root: string, meta = "meta.json") => {
    const out: string[][] = [];
    for (const id of await readdir(root).catch(() => [] as string[])) {
      const m = await readFile(path.join(root, id, meta), "utf-8").then((s) => JSON.parse(s) as { owner?: unknown }, () => null);
      if (m && isMine(m.owner, u)) out.push([path.join(root, id)]);
    }
    return out;
  };
  // one folder per account, one entry per item
  const perUser = async (root: string) => (await readdir(root).catch(() => [] as string[])).map((n) => [path.join(root, n)]);
  switch (kind) {
    case "chat-pictures":
      return perUser(at("assistant", "images", u.username));
    case "chat-videos":
      return perUser(at("assistant", "files", u.username));
    case "exports":
      return (await finishedExportDirs(u.username)).map((d) => [d]);
    case "analyzer":
      return owned(at("instagram"));
    case "workshop": {
      // sources/<id>.json names the owner; its text and pages sit beside it
      const root = at("workshop", "sources");
      const out: string[][] = [];
      for (const f of await readdir(root).catch(() => [] as string[])) {
        if (!f.endsWith(".json")) continue;
        const m = await readFile(path.join(root, f), "utf-8").then((s) => JSON.parse(s) as { owner?: unknown }, () => null);
        const id = f.slice(0, -5);
        if (m && isMine(m.owner, u)) out.push([path.join(root, f), path.join(root, `${id}.txt`), path.join(root, id)]);
      }
      return out;
    }
    case "captions":
      return owned(at("projects"));
    case "review":
      return owned(at("review"));
    case "notes":
      return owned(at("clips"));
    case "enhance":
      return owned(at("enhance"));
  }
}

export async function keptView(u: SessionUser): Promise<KeptView> {
  const rows: KeptRow[] = [];
  for (const kind of KEPT_KINDS) {
    const items = await itemsOf(kind, u);
    let bytes = 0;
    for (const paths of items) for (const p of paths) bytes += await dirBytes(p);
    const keepDays = kind === "chat-videos" ? 7 : kind === "exports" ? EXPORTS_KEEP_DAYS : undefined;
    rows.push({ kind, bytes, items: items.length, ...(keepDays ? { keepDays } : {}) });
  }
  return { rows };
}

/** Empty one kind of this account's files. A chat video still uploading stays (its turn waits for it). */
export async function emptyKept(kind: KeptKind, u: SessionUser): Promise<void> {
  if (kind === "exports") return removeFinishedExports(u.username);
  if (kind === "chat-pictures") return void (await rm(at("assistant", "images", u.username), { recursive: true, force: true }));
  if (kind === "chat-videos") {
    for (const [dir] of await itemsOf(kind, u)) {
      if (await stat(path.join(dir!, "parts")).catch(() => null)) continue;
      await removeFile(u.username, path.basename(dir!));
    }
  }
}

keptApp.get("/", async (c) => c.json(await keptView(c.get("user"))));

keptApp.post("/:kind/empty", async (c) => {
  const kind = EMPTIED.find((k) => k === c.req.param("kind"));
  if (!kind) return c.json({ error: "That can't be emptied here" }, 400);
  await emptyKept(kind, c.get("user"));
  return c.json(await keptView(c.get("user")));
});
