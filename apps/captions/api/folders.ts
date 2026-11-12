import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "./auth";
import { isFolderTool, SHAREABLE_TOOLS, type FolderTool, type ToolFolder, type ToolFolders } from "../contracts/folders";
import { env } from "./lib/env";

/**
 * Folders for the tools with none of their own (contracts/folders.ts): $DATA_DIR/folders/<tool>/<username>.json holds
 * one person's folders in that tool and which of their items is in which. The items are never written: deleting an item
 * leaves a line here that no list shows, and a folder only lists what the tool lists. A folder can sit in a folder.
 * Deleting a folder keeps what was in it: its items and its folders move up one level.
 */
export const foldersApp = new Hono<{ Variables: AuthVars }>();

const USER = /^[a-zA-Z0-9._-]{1,64}$/;
const ITEM = /^[\w.-]{1,80}$/;
const MAX_FOLDERS = 1000;
const MAX_MOVE = 500;

const fileOf = (tool: FolderTool, username: string) => path.join(env.dataDir, "folders", tool, `${username}.json`);

export async function read(tool: FolderTool, username: string): Promise<ToolFolders> {
  try {
    const v = JSON.parse(await readFile(fileOf(tool, username), "utf-8")) as Partial<ToolFolders>;
    return { folders: Array.isArray(v.folders) ? v.folders : [], items: v.items && typeof v.items === "object" ? v.items : {} };
  } catch {
    return { folders: [], items: {} };
  }
}

async function save(tool: FolderTool, username: string, data: ToolFolders) {
  const file = fileOf(tool, username);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

// one writer per file: every change reads, changes and writes the whole file
const locks = new Map<string, Promise<unknown>>();
function change<T>(tool: FolderTool, username: string, fn: (d: ToolFolders) => T | Response): Promise<T | Response> {
  const key = `${tool}/${username}`;
  const next = (locks.get(key) ?? Promise.resolve()).then(async () => {
    const d = await read(tool, username);
    const out = fn(d);
    if (!(out instanceof Response)) await save(tool, username, d);
    return out;
  });
  const settled = next.then(() => undefined, () => undefined);
  locks.set(key, settled);
  void settled.then(() => locks.get(key) === settled && locks.delete(key));
  return next;
}

const nameOf = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) : "");
/** Is `id` the folder `parent` or above it? (a folder can't go inside itself) */
function isAbove(d: ToolFolders, parent: string | null, id: string): boolean {
  const seen = new Set<string>();
  for (let p = parent; p && !seen.has(p); p = d.folders.find((f) => f.id === p)?.parentId ?? null) {
    if (p === id) return true;
    seen.add(p);
  }
  return false;
}

// a tool this file serves, and a signed-in person's own file
const guard = async (c: Ctx, next: () => Promise<void>) => {
  if (!isFolderTool(c.req.param("tool")) || !USER.test(c.get("user")?.username ?? "")) return c.json({ error: "Not found" }, 404);
  await next();
};
foldersApp.use("/:tool", guard);
foldersApp.use("/:tool/*", guard);
type Ctx = Context<{ Variables: AuthVars }>;
const ctx = (c: Ctx) => [c.req.param("tool") as FolderTool, c.get("user").username] as const;
const json = async (c: Ctx) => ((await c.req.json().catch(() => null)) ?? {}) as Record<string, unknown>;

// GET /api/folders/:tool → { folders, items }
foldersApp.get("/:tool", async (c) => c.json(await read(...ctx(c))));

// POST /api/folders/:tool { name, parentId? } → 201 the folder
foldersApp.post("/:tool", async (c) => {
  const body = await json(c);
  const name = nameOf(body.name);
  if (!name) return c.json({ error: "A name is needed" }, 400);
  const parentId = typeof body.parentId === "string" ? body.parentId : null;
  const out = await change(...ctx(c), (d) => {
    if (parentId && !d.folders.some((f) => f.id === parentId)) return c.json({ error: "Not found" }, 404);
    if (d.folders.length >= MAX_FOLDERS) return c.json({ error: `${MAX_FOLDERS} folders at most` }, 400);
    const folder: ToolFolder = { id: randomUUID(), name, parentId, createdAt: Date.now() };
    d.folders.push(folder);
    return folder;
  });
  return out instanceof Response ? out : c.json(out, 201);
});

// PATCH /api/folders/:tool/:fid { name?, parentId? } → the folder: rename it, or move it into another (null: the top)
foldersApp.patch("/:tool/:fid", async (c) => {
  const body = await json(c);
  const fid = c.req.param("fid");
  const out = await change(...ctx(c), (d) => {
    const folder = d.folders.find((f) => f.id === fid);
    if (!folder) return c.json({ error: "Not found" }, 404);
    if (body.name !== undefined) {
      const name = nameOf(body.name);
      if (!name) return c.json({ error: "A name is needed" }, 400);
      folder.name = name;
    }
    if (body.parentId !== undefined) {
      const parentId = typeof body.parentId === "string" ? body.parentId : null;
      if (parentId && !d.folders.some((f) => f.id === parentId)) return c.json({ error: "Not found" }, 404);
      if (isAbove(d, parentId, folder.id)) return c.json({ error: "A folder can't go inside itself" }, 409);
      folder.parentId = parentId;
    }
    return folder;
  });
  return out instanceof Response ? out : c.json(out);
});

// DELETE /api/folders/:tool/:fid → gone; what was in it (items and folders) moves up one level
foldersApp.delete("/:tool/:fid", async (c) => {
  const fid = c.req.param("fid");
  const out = await change(...ctx(c), (d) => {
    const folder = d.folders.find((f) => f.id === fid);
    if (!folder) return c.json({ error: "Not found" }, 404);
    for (const f of d.folders) if (f.parentId === fid) f.parentId = folder.parentId;
    for (const [item, at] of Object.entries(d.items)) {
      if (at !== fid) continue;
      if (folder.parentId) d.items[item] = folder.parentId;
      else delete d.items[item];
    }
    d.folders = d.folders.filter((f) => f !== folder);
    return { ok: true };
  });
  return out instanceof Response ? out : c.json(out);
});

// POST /api/folders/:tool/:fid/share → the folder with its link's token (kept if it has one): anyone with the link
// sees it and what is inside, its folders too. DELETE turns the link off; sharing again makes a new one.
foldersApp.post("/:tool/:fid/share", async (c) => {
  const [tool] = ctx(c);
  if (!SHAREABLE_TOOLS.includes(tool)) return c.json({ error: "Not found" }, 404);
  const fid = c.req.param("fid");
  const out = await change(...ctx(c), (d) => {
    const folder = d.folders.find((f) => f.id === fid);
    if (!folder) return c.json({ error: "Not found" }, 404);
    folder.share ??= randomBytes(16).toString("base64url");
    return folder;
  });
  return out instanceof Response ? out : c.json(out);
});
foldersApp.delete("/:tool/:fid/share", async (c) => {
  const fid = c.req.param("fid");
  const out = await change(...ctx(c), (d) => {
    const folder = d.folders.find((f) => f.id === fid);
    if (!folder) return c.json({ error: "Not found" }, 404);
    delete folder.share;
    return folder;
  });
  return out instanceof Response ? out : c.json(out);
});

export const SHARE_TOKEN = /^[A-Za-z0-9_-]{22}$/;

/** The folder a link's token shares, and whose it is. null: no such link (or it was turned off). */
// ponytail: reads every person's file of the tool per open; an index file if a server has thousands of people
export async function sharedFolder(tool: FolderTool, token: string): Promise<{ username: string; data: ToolFolders; folder: ToolFolder } | null> {
  if (!SHARE_TOKEN.test(token)) return null;
  const files = await readdir(path.join(env.dataDir, "folders", tool)).catch(() => [] as string[]);
  for (const file of files) {
    const username = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!USER.test(username)) continue;
    const data = await read(tool, username);
    const folder = data.folders.find((f) => f.share === token);
    if (folder) return { username, data, folder };
  }
  return null;
}

/** Is folder `id` the folder `root` or inside it (at any depth)? */
export const isWithin = (d: ToolFolders, root: string, id: string) => isAbove(d, id, root);

// PUT /api/folders/:tool/items { ids, folderId } → { items }: these items into a folder (null: the top)
foldersApp.put("/:tool/items", async (c) => {
  const body = await json(c);
  const ids = Array.isArray(body.ids) ? [...new Set(body.ids.filter((x): x is string => typeof x === "string" && ITEM.test(x)))] : [];
  if (!ids.length || ids.length > MAX_MOVE) return c.json({ error: `Between 1 and ${MAX_MOVE} items` }, 400);
  const folderId = typeof body.folderId === "string" ? body.folderId : null;
  const out = await change(...ctx(c), (d) => {
    if (folderId && !d.folders.some((f) => f.id === folderId)) return c.json({ error: "Not found" }, 404);
    for (const id of ids) {
      if (folderId) d.items[id] = folderId;
      else delete d.items[id];
    }
    return { items: d.items };
  });
  return out instanceof Response ? out : c.json(out);
});
