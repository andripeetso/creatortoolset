import { readFile } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { checkPack, isPackSlot, type PackSlot } from "../contracts/packs";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { installPack, listInstalled, removePack, setPackOn } from "./lib/packs";
import type { Framework } from "./lib/workshop/types";
import { packPresetStore } from "./presets";

/**
 * Settings → Packs: the person's installed packs, install from a pack file, on/off per project, remove, and
 * "Share as pack" from their own frameworks, caption styles and instructions.
 */
export const packsApp = new Hono<{ Variables: AuthVars }>();

const cantSave = (c: { get: (k: "user") => AuthVars["user"] }) => {
  const u = c.get("user");
  return u.role === "guest" || !!u.demo;
};

packsApp.get("/", async (c) => c.json(await listInstalled(c.get("user").username)));

/** The automated checks alone, for the "Install from file" preview and `pnpm pack:check`. */
packsApp.post("/check", async (c) => {
  const r = checkPack(await c.req.json().catch(() => null));
  return c.json({ ok: r.ok, problems: r.problems, level: r.level ?? null, pack: r.pack ?? null });
});

/** Install (or update) from a pack file. Unreviewed: the browser shows the warning before it gets here. */
packsApp.post("/install", async (c) => {
  if (cantSave(c)) return c.json({ error: "Sign in to install packs" }, 403);
  const b = await c.req.json().catch(() => null);
  const r = checkPack(b?.pack);
  if (!r.ok) return c.json({ error: "This pack didn't pass the checks", problems: r.problems }, 400);
  const projectId = typeof b?.projectId === "string" && /^[a-z0-9-]{1,64}$/i.test(b.projectId) ? b.projectId : undefined;
  const user = c.get("user");
  const out = await installPack(user.username, r.pack!, r.level!, { projectId });
  return c.json(out, 201);
});

/** On/off: `{on, projectId?}`; no project = everywhere. */
packsApp.patch("/:id", async (c) => {
  if (cantSave(c)) return c.json({ error: "Sign in to change packs" }, 403);
  const b = await c.req.json().catch(() => null);
  if (typeof b?.on !== "boolean") return c.json({ error: "on: true or false" }, 400);
  const projectId = typeof b?.projectId === "string" ? b.projectId : undefined;
  const p = await setPackOn(c.get("user").username, c.req.param("id"), b.on, projectId);
  return p ? c.json(p) : c.json({ error: "Not installed" }, 404);
});

packsApp.delete("/:id", async (c) => {
  if (cantSave(c)) return c.json({ error: "Sign in to change packs" }, 403);
  const r = await removePack(c.get("user").username, c.req.param("id"));
  return r.removed ? c.json(r) : c.json({ error: "Not installed" }, 404);
});

/**
 * "Share as pack": `{id, name, version, description, license, niche?, frameworks: ids, presets: ids,
 * instructions: {slot: text}}` → a checked pack file built from the person's own items.
 */
packsApp.post("/export", async (c) => {
  const user = c.get("user");
  const b = await c.req.json().catch(() => null);
  if (!b || typeof b !== "object") return c.json({ error: "Expected JSON" }, 400);
  const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : []);

  const frameworks = [];
  for (const id of ids(b.frameworks)) {
    if (!/^[a-zA-Z0-9-]{1,64}$/.test(id)) continue;
    const f = JSON.parse(await readFile(path.join(env.dataDir, "workshop", "frameworks", `${id}.json`), "utf-8").catch(() => "null")) as Framework | null;
    if (!f || f.owner !== user.username) continue;
    frameworks.push({ name: f.name, role: f.role, summary: f.summary, steps: f.steps, whenToUse: f.whenToUse,
      ...(f.pairsWith ? { pairsWith: f.pairsWith } : {}), ...(f.example ? { example: f.example } : {}) });
  }
  const want = new Set(ids(b.presets));
  const captionStyles = packPresetStore.all()
    .filter((p) => want.has(p.id) && (p.owner === user.username || p.scope === "global"))
    .map((p) => ({ name: p.name, kind: p.kind, style: p.style }));
  const instructions: Partial<Record<PackSlot, string>> = {};
  if (b.instructions && typeof b.instructions === "object")
    for (const [slot, text] of Object.entries(b.instructions as Record<string, unknown>))
      if (isPackSlot(slot) && typeof text === "string" && text.trim()) instructions[slot] = text;

  const r = checkPack({
    format: 1, id: b.id, name: b.name, version: b.version ?? "1.0.0", author: b.author ?? user.username,
    license: b.license, description: b.description, niche: b.niche, homepage: b.homepage,
    ...(Object.keys(instructions).length ? { instructions } : {}),
    ...(frameworks.length ? { frameworks } : {}),
    ...(captionStyles.length ? { captionStyles } : {}),
  });
  return r.ok ? c.json({ pack: r.pack, level: r.level }) : c.json({ error: "Not ready to share yet", problems: r.problems }, 400);
});
