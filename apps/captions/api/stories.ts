import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import type { SessionUser } from "./users";

/**
 * Story Splitter's saved splits: the cuts, never the video. One file per split,
 * $DATA_DIR/stories/<id>.json. Accounts only (boot.ts).
 */

export const storiesApp = new Hono<{ Variables: AuthVars }>();

export interface StorySplit {
  id: string;
  owner: string;
  /** The video's file name (a local file is asked for again by it). */
  name: string;
  /** Seconds, in order. */
  cuts: number[];
  /** The page's story length. */
  target: number;
  duration: number;
  createdAt: number;
  updatedAt: number;
}

const DIR = path.join(env.dataDir, "stories");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CUTS = 200;
const file = (id: string) => path.join(DIR, `${id}.json`);
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

async function read(id: string): Promise<StorySplit | null> {
  if (!UUID.test(id)) return null;
  try {
    return JSON.parse(await readFile(file(id), "utf-8")) as StorySplit;
  } catch {
    return null;
  }
}

async function save(split: StorySplit) {
  await mkdir(DIR, { recursive: true });
  await writeFile(file(split.id), JSON.stringify(split));
}

/** Own splits; admins reach anyone's by id, as in the other apps. */
const mine = (split: StorySplit | null, user: SessionUser) =>
  split && (split.owner === user.username || user.role === "admin") ? split : null;

/** What a body may set, checked against the video's length; a string says what's wrong. */
function fields(body: Record<string, unknown>, duration: number): Partial<StorySplit> | string {
  const out: Partial<StorySplit> = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 160) return "Name it, 160 characters at most";
    out.name = body.name.trim();
  }
  if (body.target !== undefined) {
    if (!num(body.target) || body.target <= 0 || body.target > 600) return "The story length is off";
    out.target = body.target;
  }
  if (body.cuts !== undefined) {
    const cuts = body.cuts;
    if (!Array.isArray(cuts) || cuts.length > MAX_CUTS || !cuts.every((t) => num(t) && t >= 0 && t <= duration)) {
      return `Cuts are times within the video, ${MAX_CUTS} at most`;
    }
    out.cuts = (cuts as number[]).slice().sort((a, b) => a - b);
  }
  return out;
}

storiesApp.get("/", async (c) => {
  const user = c.get("user");
  const names = await readdir(DIR).catch(() => [] as string[]);
  const splits = await Promise.all(names.filter((n) => n.endsWith(".json")).map((n) => read(n.slice(0, -5))));
  return c.json(
    splits
      .filter((s): s is StorySplit => !!s && s.owner === user.username)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  );
});

storiesApp.get("/:id", async (c) => {
  const split = mine(await read(c.req.param("id")), c.get("user"));
  return split ? c.json(split) : c.json({ error: "Not found" }, 404);
});

storiesApp.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const { duration } = body ?? {};
  if (!body || !num(duration) || duration <= 0 || duration > 86_400) return c.json({ error: "The video's length is off" }, 400);
  const f = fields(body, duration);
  if (typeof f === "string") return c.json({ error: f }, 400);
  if (!f.name || !f.cuts || f.target === undefined) return c.json({ error: "A split needs a name, its cuts and the story length" }, 400);
  const now = Date.now();
  const split: StorySplit = {
    id: randomUUID(),
    owner: c.get("user").username,
    name: f.name,
    cuts: f.cuts,
    target: f.target,
    duration,
    createdAt: now,
    updatedAt: now,
  };
  await save(split);
  return c.json(split);
});

storiesApp.put("/:id", async (c) => {
  const split = mine(await read(c.req.param("id")), c.get("user"));
  if (!split) return c.json({ error: "Not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const f = body ? fields(body, split.duration) : "Bad request";
  if (typeof f === "string") return c.json({ error: f }, 400);
  const next = { ...split, ...f, updatedAt: Date.now() };
  await save(next);
  return c.json(next);
});

storiesApp.delete("/:id", async (c) => {
  const split = mine(await read(c.req.param("id")), c.get("user"));
  if (!split) return c.json({ error: "Not found" }, 404);
  await rm(file(split.id), { force: true });
  return c.json({ ok: true });
});
