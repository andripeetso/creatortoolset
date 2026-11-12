import { Hono } from "hono";
import { lstat, readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { EMPTIED, KEPT_KINDS, type KeptKind, type KeptRow, type KeptView } from "../contracts/storage";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import type { SessionUser } from "./users";

/**
 * Settings → Storage, "Kept on the server" (contracts/storage.ts KEPT_KINDS), mounted at /api/devices/storage/kept:
 *   GET  /              → KeptView: this account's files in the server's data folder, by kind (size and count)
 *   POST /:kind/empty   → deletes this account's files of one EMPTIED kind: the trash, a chat's pictures and videos,
 *                         finished renders. Work (projects, Review videos, posts…) is deleted in its own tool.
 * Only the caller's own files: a kind's folder is fixed here, never sent by the client. A file with no owner (made before
 * accounts) counts as an admin's, as the admin panel does.
 *
 * One file often has two names (a hard link, no copy): a Review video is the same file in the Media Library, and a chat
 * video handed to Review, Video Notes or Caption Studio is that tool's file. Such a file counts once, in the first kind of
 * KEPT_KINDS that has it. A chat video with a second name never counts as the chat's (that name is another tool's work,
 * or the person's own file on this computer): Empty leaves it, since deleting it would free nothing.
 *
 * The tools' modules are imported when used: at load they would close an import loop through the routes this file is
 * mounted beside.
 *
 * ponytail: sizes are read from disk on every request (one lstat per file). Fine for tens of thousands of files; a
 * running total per account when a server holds far more, or when an allowance has to be checked on every upload.
 */

export const keptApp = new Hono<{ Variables: AuthVars }>();

interface OneFile {
  size: number;
  /** device and inode: the same for every name of one file */
  id: string;
  links: number;
}

/** Every file under a path (a folder tree, or one file). A symlink is not followed. */
async function filesOf(p: string, out: OneFile[] = []): Promise<OneFile[]> {
  const st = await lstat(p).catch(() => null);
  if (!st) return out;
  if (st.isDirectory()) for (const name of await readdir(p).catch(() => [] as string[])) await filesOf(path.join(p, name), out);
  else if (st.isFile()) out.push({ size: st.size, id: `${st.dev}:${st.ino}`, links: st.nlink });
  return out;
}

/** Total size of a folder tree, or of one file. */
export const dirBytes = async (p: string): Promise<number> => (await filesOf(p)).reduce((n, f) => n + f.size, 0);

const at = (...p: string[]) => path.join(env.dataDir, ...p);
const isMine = (owner: unknown, u: SessionUser) => owner === u.username || (!owner && u.role === "admin");
const json = (file: string) => readFile(file, "utf-8").then((s) => JSON.parse(s) as Record<string, unknown>, () => null);

/** One thing an account keeps: its id in its own store, and its paths on disk. */
interface Item {
  id: string;
  paths: string[];
}

/** The items of a kind that belong to `u`. */
async function itemsOf(kind: KeptKind, u: SessionUser): Promise<Item[]> {
  // `<root>/<id>/<meta>` stores whose meta names the owner (`by`), kept when `pick` says so
  const owned = async (root: string, pick: (m: Record<string, unknown>) => boolean = () => true, meta = "meta.json", by = "owner") => {
    const out: Item[] = [];
    for (const id of await readdir(root).catch(() => [] as string[])) {
      const m = await json(path.join(root, id, meta));
      if (m && isMine(m[by], u) && pick(m)) out.push({ id, paths: [path.join(root, id)] });
    }
    return out;
  };
  // one folder per account, one entry per item
  const perUser = async (root: string) => (await readdir(root).catch(() => [] as string[])).map((id) => ({ id, paths: [path.join(root, id)] }));
  switch (kind) {
    case "captions":
      return owned(at("projects"), (m) => !m.deletedAt);
    case "captions-trash":
      return owned(at("projects"), (m) => !!m.deletedAt);
    case "review":
      return owned(at("review"));
    case "review-trash":
      return owned(at("review", "trash"));
    case "notes":
      return owned(at("clips"));
    case "guides":
      return owned(at("documents"));
    case "enhance":
      return owned(at("enhance"));
    case "editor":
      return owned(at("editor"), undefined, "edit.json", "createdBy");
    case "analyzer":
      return owned(at("instagram"));
    case "workshop": {
      // a session's folder; a source is sources/<id>.json (it names the owner) with its text and pages beside it
      const root = at("workshop", "sources");
      const out = await owned(at("workshop", "sessions"));
      for (const f of await readdir(root).catch(() => [] as string[])) {
        if (!f.endsWith(".json")) continue;
        const id = f.slice(0, -5);
        if (isMine((await json(path.join(root, f)))?.owner, u)) out.push({ id, paths: [path.join(root, f), path.join(root, `${id}.txt`), path.join(root, id)] });
      }
      return out;
    }
    case "library": {
      // the libraries of the account's own workspace, kept on this server's disk (a bucket's bytes are added in keptView)
      const { libraryDb } = await import("./library/db");
      const { homeOf } = await import("./library/access");
      const libs = libraryDb().prepare("SELECT id FROM libraries WHERE workspace_id = ?").all(homeOf(u.username)) as { id: string }[];
      return libs.map((l) => ({ id: l.id, paths: [at("library", "blobs", "libraries", l.id)] }));
    }
    case "chat-pictures":
      return perUser(at("assistant", "images", u.username));
    case "chat-videos": {
      // one still uploading is not the page's to count or empty: the message waiting for it ends it, or the hourly sweep
      const all = await perUser(at("assistant", "files", u.username));
      const uploading = await Promise.all(all.map((i) => lstat(path.join(i.paths[0]!, "parts")).then(() => true, () => false)));
      return all.filter((_, n) => !uploading[n]);
    }
    case "exports":
      return (await (await import("./exports")).finishedExportDirs(u.username)).map((d) => ({ id: path.basename(d), paths: [d] }));
  }
}

/** What a bucket library holds (usage_daily's newest day): the disk has none of it. */
async function bucketBytes(libraryIds: string[]): Promise<number> {
  const { libraryDb } = await import("./library/db");
  const row = libraryDb().prepare("SELECT stored_bytes AS n FROM usage_daily WHERE library_id = ? ORDER BY day DESC LIMIT 1");
  return libraryIds.reduce((n, id) => n + ((row.get(id) as { n: number } | undefined)?.n ?? 0), 0);
}

async function keepDaysOf(kind: KeptKind): Promise<number | undefined> {
  if (kind === "chat-videos") return 7;
  if (kind === "exports") return (await import("./exports")).EXPORTS_KEEP_DAYS;
  if (kind === "captions-trash") return (await import("./projects")).PROJECT_TRASH_DAYS;
  if (kind === "review-trash") return (await import("./review")).REVIEW_TRASH_DAYS;
  return undefined;
}

/**
 * Every kind's items and their size, each file counted once (`seen` holds the files with a second name already counted).
 * `listed` is what a kind's row stands for: the items Empty deletes.
 */
async function measure(u: SessionUser): Promise<Array<KeptRow & { listed: Item[] }>> {
  const seen = new Set<string>();
  const rows: Array<KeptRow & { listed: Item[] }> = [];
  for (const kind of KEPT_KINDS) {
    const listed: Item[] = [];
    let bytes = 0;
    for (const item of await itemsOf(kind, u)) {
      const files = (await Promise.all(item.paths.map((p) => filesOf(p)))).flat();
      let size = 0;
      for (const f of files) {
        if (f.links > 1) {
          if (kind === "chat-videos" || seen.has(f.id)) continue;
          seen.add(f.id);
        }
        size += f.size;
      }
      // a chat video that is mostly another tool's file, or the person's own, is not the chat's to count or delete
      if (kind === "chat-videos" && size * 2 < files.reduce((n, f) => n + f.size, 0)) continue;
      bytes += size;
      listed.push(item);
    }
    if (kind === "library") bytes += await bucketBytes(listed.map((i) => i.id));
    const keepDays = await keepDaysOf(kind);
    // a library is counted by its size alone: its folder is there before anything is in it
    rows.push({ kind, bytes, items: kind === "library" ? 0 : listed.length, ...(keepDays ? { keepDays } : {}), listed });
  }
  return rows;
}

export async function keptView(u: SessionUser): Promise<KeptView> {
  return { rows: (await measure(u)).map(({ listed: _, ...row }) => row), here: process.env.CT_LOCAL === "1" };
}

/** Empty one kind: exactly the items its row counts go, each the way its own tool deletes it. */
export async function emptyKept(kind: KeptKind, u: SessionUser): Promise<void> {
  const listed = (await measure(u)).find((r) => r.kind === kind)?.listed ?? [];
  if (kind === "captions-trash") return (await import("./projects")).emptyProjectTrash(listed.map((i) => i.id));
  if (kind === "review-trash") return (await import("./review")).emptyReviewTrash(listed.map((i) => i.id));
  if (kind === "exports") return (await import("./exports")).removeFinishedExports(u.username, listed.flatMap((i) => i.paths));
  // a chat's pictures and videos are plain files of this account's own folder
  if (kind === "chat-pictures" || kind === "chat-videos")
    for (const p of listed.flatMap((i) => i.paths)) await rm(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

keptApp.get("/", async (c) => c.json(await keptView(c.get("user"))));

keptApp.post("/:kind/empty", async (c) => {
  const kind = EMPTIED.find((k) => k === c.req.param("kind"));
  if (!kind) return c.json({ error: "That can't be emptied here" }, 400);
  await emptyKept(kind, c.get("user"));
  return c.json(await keptView(c.get("user")));
});
