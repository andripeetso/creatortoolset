import { Hono, type Context } from "hono";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "./auth";
import { FOLDER_TOOLS, isFolderTool, SHAREABLE_TOOLS, type FolderTool, type ToolFolder, type ToolFolders } from "../contracts/folders";
import { env } from "./lib/env";
import { currentWorkspaceId, inCurrentWorkspace } from "./lib/workspace-scope";
import { writeJsonAtomic } from "./lib/write-json";

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

// only a missing file is an empty list: any other read error, or a file that is not JSON, throws, so change() never saves
// an empty list over the person's folders
export async function read(tool: FolderTool, username: string): Promise<ToolFolders> {
  const raw = await readFile(fileOf(tool, username), "utf-8").catch((e: NodeJS.ErrnoException) => {
    if (e.code === "ENOENT") return "{}";
    throw e;
  });
  const v = JSON.parse(raw) as Partial<ToolFolders>;
  return { folders: Array.isArray(v.folders) ? v.folders : [], items: v.items && typeof v.items === "object" ? v.items : {} };
}

async function save(tool: FolderTool, username: string, data: ToolFolders) {
  await writeJsonAtomic(fileOf(tool, username), data);
}

// one writer per file: every change reads, changes and writes the whole file. Exported for a plug-in that files its own
// items server-side (the studio's Editor puts each version of a video in that video's folder)
export { change as changeFolders };
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

// GET /api/folders/:tool → { folders, items }: the folders of the workspace the request works in. Only the answer is
// filtered, never read(): change() saves what read() gives, which would drop the other workspaces' folders
foldersApp.get("/:tool", async (c) => {
  const [tool, username] = ctx(c);
  const d = await read(tool, username);
  // every tool here keeps its items per workspace, so its folders are too (a folder of another workspace isn't listed)
  const here = await inCurrentWorkspace(c.get("user"));
  return c.json(here ? { ...d, folders: d.folders.filter((f) => here(f.workspace)) } : d);
});

// POST /api/folders/:tool { name, parentId? } → 201 the folder
foldersApp.post("/:tool", async (c) => {
  const body = await json(c);
  const name = nameOf(body.name);
  if (!name) return c.json({ error: "A name is needed" }, 400);
  const parentId = typeof body.parentId === "string" ? body.parentId : null;
  const workspace = await currentWorkspaceId(c.get("user"));
  const out = await change(...ctx(c), (d) => {
    if (parentId && !d.folders.some((f) => f.id === parentId)) return c.json({ error: "Not found" }, 404);
    if (d.folders.length >= MAX_FOLDERS) return c.json({ error: `${MAX_FOLDERS} folders at most` }, 400);
    const folder: ToolFolder = { id: randomUUID(), name, parentId, createdAt: Date.now(), ...(workspace ? { workspace } : {}) };
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
/** The account's folders in every tool kept to a workspace being deleted (lib/workspace-delete.ts), share links with them; the items are each tool's. */
export async function workspaceToolFolders(username: string, has: (ws?: string) => boolean): Promise<{ n: number; drop: () => Promise<void> }> {
  const hit = await Promise.all(FOLDER_TOOLS.map(async (t) => [t, new Set((await read(t, username)).folders.filter((f) => has(f.workspace)).map((f) => f.id))] as const));
  return {
    n: hit.reduce((n, [, ids]) => n + ids.size, 0),
    drop: async () => {
      for (const [t, ids] of hit) {
        if (!ids.size) continue;
        await change(t, username, (d) => {
          d.folders = d.folders.filter((f) => !ids.has(f.id));
          for (const f of d.folders) if (f.parentId && ids.has(f.parentId)) f.parentId = null;
          for (const [item, at] of Object.entries(d.items)) if (ids.has(at)) delete d.items[item];
        });
      }
    },
  };
}

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
    // one person's unreadable file must not hide everyone else's shared folders
    const data = await read(tool, username).catch(() => null);
    if (!data) continue;
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
