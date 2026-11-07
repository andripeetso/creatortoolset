import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import type { AuthVars } from "./auth";
import type { PackOrigin } from "../contracts/packs";
import { env } from "./lib/env";

/**
 * Custom style presets, file-based like users.json:
 * $DATA_DIR/presets.json.
 *
 * Scoping: presets created by an admin are global (everyone sees them);
 * presets created by regular users are private to their account.
 * A global preset with the same name as a built-in overrides it in the
 * client. Admins may update/delete any preset; users only their own.
 */

export interface PresetRecord {
  id: string;
  name: string;
  kind: "caption" | "text";
  scope: "global" | "user";
  owner: string; // username of the creator
  style: Record<string, unknown>;
  createdAt: number;
  /** Installed from a community pack (api/lib/packs.ts); dropped once the person saves over it. */
  from?: PackOrigin;
}

const PRESETS_FILE = path.join(env.dataDir, "presets.json");

function load(): PresetRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(PRESETS_FILE, "utf-8"));
    return Array.isArray(parsed.presets) ? parsed.presets : [];
  } catch {
    return [];
  }
}

const presets: PresetRecord[] = load();

// serialize writes so concurrent saves can't interleave the tmp file
let writeChain: Promise<void> = Promise.resolve();

function persist(): void {
  const snapshot = JSON.stringify({ presets }, null, 2);
  writeChain = writeChain.then(async () => {
    try {
      await mkdir(env.dataDir, { recursive: true });
      const tmp = PRESETS_FILE + ".tmp";
      await writeFile(tmp, snapshot);
      await rename(tmp, PRESETS_FILE);
    } catch (e) {
      console.error("[presets] failed to persist presets.json:", e);
    }
  });
}

/** For api/lib/packs.ts: the live list (install adds to it, remove takes from it) and the writer. */
export const packPresetStore = { all: () => presets, save: persist };

export const presetsApp = new Hono<{ Variables: AuthVars }>();

/** Presets visible to the caller: all global ones + their own. */
presetsApp.get("/", (c) => {
  const user = c.get("user")!;
  const visible = presets.filter(
    (p) => p.scope === "global" || p.owner === user.username
  );
  return c.json(visible);
});

/**
 * Create (or overwrite by name) a preset. Admin-created presets are
 * global — they apply to everyone and shadow same-named built-ins;
 * everyone else's are account-private.
 */
presetsApp.post("/", async (c) => {
  const user = c.get("user")!;
  if (user.role === "visitor") return c.json({ error: "Sign in to save presets" }, 403);
  const body = await c.req.json().catch(() => null);
  const name = String(body?.name ?? "").trim().slice(0, 40);
  const kind = body?.kind === "text" ? "text" : "caption";
  const style = body?.style;
  if (!name || typeof style !== "object" || style === null) {
    return c.json({ error: "name and style are required" }, 400);
  }
  const scope: PresetRecord["scope"] =
    user.role === "admin" ? "global" : "user";

  // same name + kind within the caller's write scope → overwrite
  const existing = presets.find(
    (p) =>
      p.kind === kind &&
      p.name.toLowerCase() === name.toLowerCase() &&
      (p.scope === "global"
        ? user.role === "admin"
        : p.owner === user.username)
  );
  if (existing) {
    existing.style = style;
    existing.scope = scope;
    existing.owner = user.username;
    delete existing.from;
    persist();
    return c.json(existing);
  }
  const rec: PresetRecord = {
    id: randomBytes(8).toString("hex"),
    name,
    kind,
    scope,
    owner: user.username,
    style,
    createdAt: Date.now(),
  };
  presets.push(rec);
  persist();
  return c.json(rec, 201);
});

/** Delete a preset — admins any, users their own. */
presetsApp.delete("/:id", (c) => {
  const user = c.get("user")!;
  const i = presets.findIndex((p) => p.id === c.req.param("id"));
  if (i < 0) return c.json({ error: "Not found" }, 404);
  const p = presets[i];
  if (user.role !== "admin" && p.owner !== user.username) {
    return c.json({ error: "Forbidden" }, 403);
  }
  presets.splice(i, 1);
  persist();
  return c.json({ ok: true });
});
