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
 * accounts) counts as the server's first admin's.
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
// a file with no owner (made before accounts) is the server's first admin's, so two admins never both count it
const legacyOwner = () => (env.appSecret ? env.adminUsername : "local");
const isMine = (owner: unknown, u: Who) => owner === u.username || (!owner && u.username === legacyOwner());
const json = (file: string) => readFile(file, "utf-8").then((s) => JSON.parse(s) as Record<string, unknown>, () => null);

/** The account asked about: its own request, or one row of the admin's list. */
type Who = Pick<SessionUser, "username">;
/**
 * The metas of the stores read so far, by folder: one request reads each store once, however many accounts it asks
 * about (the admin's list asks about every account).
 */
export type Stores = Map<string, Promise<Array<{ id: string; m: Record<string, unknown> }>>>;
function storeOf(stores: Stores, root: string, file: (name: string) => string | null): Promise<Array<{ id: string; m: Record<string, unknown> }>> {
  let all = stores.get(root);
  if (!all) {
    all = (async () => {
      const out: Array<{ id: string; m: Record<string, unknown> }> = [];
      for (const name of await readdir(root).catch(() => [] as string[])) {
        const f = file(name);
        const m = f ? await json(f) : null;
        if (m) out.push({ id: name, m });
      }
      return out;
    })();
    stores.set(root, all);
  }
  return all;
}

/** One thing an account keeps: its id in its own store, and its paths on disk. */
interface Item {
  id: string;
  paths: string[];
}

/** The items of a kind that belong to `u`. */
async function itemsOf(kind: KeptKind, u: Who, stores: Stores): Promise<Item[]> {
  // `<root>/<id>/<meta>` stores whose meta names the owner (`by`), kept when `pick` says so
  const owned = async (root: string, pick: (m: Record<string, unknown>) => boolean = () => true, meta = "meta.json", by = "owner") =>
    (await storeOf(stores, root, (id) => path.join(root, id, meta))).filter(({ m }) => isMine(m[by], u) && pick(m)).map(({ id }) => ({ id, paths: [path.join(root, id)] }));
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
      const sources = await storeOf(stores, root, (f) => (f.endsWith(".json") ? path.join(root, f) : null));
      return [
        ...(await owned(at("workshop", "sessions"))),
        ...sources.filter(({ m }) => isMine(m.owner, u)).map(({ id: f }) => ({ id: f.slice(0, -5), paths: [path.join(root, f), path.join(root, `${f.slice(0, -5)}.txt`), path.join(root, f.slice(0, -5))] })),
      ];
    }
    case "designs": {
      // one folder an account (api/designs.ts): a design is <id>.json with its pictures in <id>/
      const root = at("designs", u.username);
      return (await readdir(root).catch(() => [] as string[])).filter((f) => f.endsWith(".json")).map((f) => ({ id: f.slice(0, -5), paths: [path.join(root, f), path.join(root, f.slice(0, -5))] }));
    }
    case "library": {
      // the libraries of the account's own workspace, kept on this server's disk (a bucket's bytes are added in measure)
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

/**
 * A project's originals that are in the server's bucket, not on its disk (a clip's originalObjectKey): each clip's
 * size as it was uploaded. A copy that shares another project's original doesn't count it again.
 */
async function bucketOriginals(stores: Stores, projectIds: string[]): Promise<number> {
  const { sourceObjectKey } = await import("./media-store");
  const metas = await storeOf(stores, at("projects"), (id) => path.join(at("projects"), id, "meta.json"));
  let n = 0;
  for (const { id, m } of metas) {
    if (!projectIds.includes(id) || !Array.isArray(m.clips)) continue;
    for (const c of m.clips as Array<{ id?: string; originalObjectKey?: string; originalBytes?: number }>)
      if (c.id && c.originalObjectKey === sourceObjectKey(id, c.id)) n += c.originalBytes ?? 0;
  }
  return n;
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
async function measure(u: Who, stores: Stores = new Map()): Promise<Array<KeptRow & { listed: Item[] }>> {
  const seen = new Set<string>();
  const rows: Array<KeptRow & { listed: Item[] }> = [];
  for (const kind of KEPT_KINDS) {
    const listed: Item[] = [];
    let bytes = 0;
    for (const item of await itemsOf(kind, u, stores)) {
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
    if (kind === "captions" || kind === "captions-trash") bytes += await bucketOriginals(stores, listed.map((i) => i.id));
    const keepDays = await keepDaysOf(kind);
    // a library is counted by its size alone: its folder is there before anything is in it
    rows.push({ kind, bytes, items: kind === "library" ? 0 : listed.length, ...(keepDays ? { keepDays } : {}), listed });
  }
  return rows;
}

/** `stores`: shared by a request that asks about several accounts (the admin's list), so each store is read once. */
export async function keptView(u: Who, stores?: Stores): Promise<KeptView> {
  return { rows: (await measure(u, stores)).map(({ listed: _, ...row }) => row), here: process.env.CT_LOCAL === "1" };
}

/** Empty one kind: exactly the items its row counts go, each the way its own tool deletes it. */
export async function emptyKept(kind: KeptKind, u: Who): Promise<void> {
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
