import { createHash } from "node:crypto";
import { readFile, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { LUT_MAX_BYTES, readCube, type CameraLut } from "../../contracts/camera";
import type { AuthVars } from "../auth";
import type { SessionUser } from "../users";
import { env } from "../lib/env";
import { currentWorkspaceId } from "../lib/workspace-scope";
import { writeJsonAtomic } from "../library/media/run";

/**
 * The LUTs added under Colour in Settings → Tools → AI Editor, per workspace (the one the request works in, as the
 * Editor's defaults; a person with none keeps their own): $DATA_DIR/edit-steps/luts/<workspace>/, each .cube as it was
 * added plus index.json. Mounted at /api/edit-steps/luts, so the AI Editor's switch and Read (boot.ts TOOL_GATES,
 * WRITE_GATES) hold here too: Read lists and downloads, never adds, renames or deletes. Workers download one by id
 * before a render. Nothing here applies a LUT.
 */
const ID = /^lut_[0-9a-f]{12}$/;

async function dirOf(user: SessionUser): Promise<string> {
  const ws = await currentWorkspaceId(user);
  return path.join(env.dataDir, "edit-steps", "luts", encodeURIComponent(ws ? `w-${ws}` : `u-${user.username}`));
}
const listOf = async (dir: string): Promise<CameraLut[]> => JSON.parse(await readFile(path.join(dir, "index.json"), "utf8").catch(() => "[]")) as CameraLut[];

// one change at a time, so two adds at once never write over each other's index
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
};

export const lutsApp = new Hono<{ Variables: AuthVars }>();

lutsApp.get("/", async (c) => c.json(await listOf(await dirOf(c.get("user")))));

lutsApp.post("/", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const file = form.file;
  if (!(file instanceof File)) return c.json({ error: "Send a .cube file", code: "invalid" }, 400);
  if (file.size > LUT_MAX_BYTES) return c.json({ error: `The file is over ${LUT_MAX_BYTES >> 20} MB`, code: "invalid" }, 400);
  const bytes = Buffer.from(await file.arrayBuffer());
  const cube = readCube(bytes.toString("utf8"));
  if ("error" in cube) return c.json({ error: cube.error, code: "invalid" }, 400);
  const id = `lut_${createHash("sha256").update(bytes).digest("hex").slice(0, 12)}`;
  const dir = await dirOf(c.get("user"));
  return c.json(
    await serial(async () => {
      const list = await listOf(dir);
      if (list.some((l) => l.id === id)) return list; // the same file again
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, `${id}.cube`), bytes);
      const name = (file.name.replace(/\.cube$/i, "").trim() || cube.title || "LUT").slice(0, 80);
      const next = [...list, { id, name, size: cube.size, bytes: bytes.length, addedAt: Date.now() }];
      await writeJsonAtomic(path.join(dir, "index.json"), next);
      return next;
    }),
  );
});

lutsApp.put("/:id", async (c) => {
  const id = c.req.param("id");
  const name = ((await c.req.json().catch(() => ({}))) as { name?: unknown }).name;
  if (typeof name !== "string" || !name.trim()) return c.json({ error: "A LUT needs a name", code: "invalid" }, 400);
  const dir = await dirOf(c.get("user"));
  const next = await serial(async () => {
    const list = await listOf(dir);
    const lut = list.find((l) => l.id === id);
    if (!lut) return null;
    lut.name = name.trim().slice(0, 80);
    await writeJsonAtomic(path.join(dir, "index.json"), list);
    return list;
  });
  return next ? c.json(next) : c.json({ error: "Not found" }, 404);
});

lutsApp.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const dir = await dirOf(c.get("user"));
  const next = await serial(async () => {
    const list = await listOf(dir);
    if (!ID.test(id) || !list.some((l) => l.id === id)) return null;
    const rest = list.filter((l) => l.id !== id);
    await writeJsonAtomic(path.join(dir, "index.json"), rest);
    await rm(path.join(dir, `${id}.cube`), { force: true });
    return rest;
  });
  return next ? c.json(next) : c.json({ error: "Not found" }, 404);
});

/** The file as it was added, for a worker to render with. */
lutsApp.get("/:id", async (c) => {
  const id = c.req.param("id");
  const dir = await dirOf(c.get("user"));
  if (!ID.test(id) || !(await listOf(dir)).some((l) => l.id === id)) return c.json({ error: "Not found" }, 404);
  const bytes = await readFile(path.join(dir, `${id}.cube`)).catch(() => null);
  return bytes ? c.body(bytes, 200, { "content-type": "application/octet-stream", "content-disposition": `attachment; filename="${id}.cube"` }) : c.json({ error: "Not found" }, 404);
});
