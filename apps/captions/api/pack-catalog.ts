import { Hono } from "hono";
import { checkPack, compareVersions, isPackSlot } from "../contracts/packs";
import type { CatalogDetail, CatalogInstallResult, UpdateRow } from "../contracts/pack-catalog";
import type { AuthVars } from "./auth";
import { env } from "./lib/env";
import { installPack, listInstalled, markDelisted, parseProjectIds } from "./lib/packs";

/**
 * The community catalog, read side: browse, install and update notices from the shared catalog at PACK_CATALOG_URL
 * (a list to read, like a plugin directory). This server keeps no catalog of its own; publishing answers with a link
 * to the catalog's site, where packs are submitted and reviewed. An empty PACK_CATALOG_URL turns the catalog off.
 */

const SAFE_ID = /^[a-z0-9][a-z0-9-]{1,47}$/;
const OFF = { error: "The community catalog is off on this server (PACK_CATALOG_URL is empty)" };
const DOWN = { error: "The community catalog can't be reached" };

const base = () => env.packCatalogUrl.replace(/\/+$/, "");
/** GET on the shared catalog's public routes. Throws when it can't be reached. */
const catalogGet = (suffix: string, query = ""): Promise<Response> =>
  fetch(`${base()}/api/pack-catalog/public${suffix}${query}`, { signal: AbortSignal.timeout(8000) });

type Resolved = { listed: CatalogDetail } | { delisted: string };

/** One id from the shared catalog: its listed latest version, or that it was delisted. Throws when it's down. */
async function resolve(id: string): Promise<Resolved | null> {
  if (!SAFE_ID.test(id) || !env.packCatalogUrl) return null;
  const r = await catalogGet(`/${id}`);
  if (r.status === 404) return null;
  if (r.status === 410) {
    const body = (await r.json().catch(() => null)) as { reason?: string } | null;
    return { delisted: body?.reason ?? "Delisted" };
  }
  if (!r.ok) throw new Error(`The community catalog answered ${r.status}`);
  return { listed: (await r.json()) as CatalogDetail };
}

// a share-link visitor reads what was shared with them and keeps nothing
const cantSave = (u: AuthVars["user"]) => u.role === "visitor";

/** Mounted behind the account gate at /api/pack-catalog (api/boot.ts). */
export const packCatalogApp = new Hono<{ Variables: AuthVars }>()
  .get("/public", async (c) => {
    if (!env.packCatalogUrl) return c.json(OFF, 404);
    const q = (c.req.query("q") ?? "").trim();
    const slot = c.req.query("slot") ?? "";
    if (slot && !isPackSlot(slot)) return c.json({ error: `Unknown slot "${slot}"` }, 400);
    const r = await catalogGet("", `?${new URLSearchParams({ q, slot })}`).catch(() => null);
    if (!r) return c.json(DOWN, 502);
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  })
  .get("/public/:id", async (c) => {
    if (!env.packCatalogUrl) return c.json(OFF, 404);
    const r = await resolve(c.req.param("id")).catch(() => "down" as const);
    if (r === "down") return c.json(DOWN, 502);
    if (!r) return c.json({ error: "Not in the catalog" }, 404);
    if ("delisted" in r) return c.json({ error: "This pack was removed from the catalog", reason: r.delisted }, 410);
    return c.json(r.listed);
  })
  /** Installed packs with a newer listed version, and the ones the catalog delisted (their instructions stop). */
  .get("/updates", async (c) => {
    const rows: UpdateRow[] = [];
    if (!env.packCatalogUrl) return c.json(rows);
    const username = c.get("user").username;
    const installed = await listInstalled(username);
    // in parallel, so a slow catalog costs one timeout, not one per pack
    const found = await Promise.all(installed.map((p) => resolve(p.id).catch(() => null)));
    for (const [i, p] of installed.entries()) {
      const r = found[i];
      if (!r) continue;
      if ("delisted" in r) {
        rows.push({ id: p.id, installed: p.version, latest: null, delisted: r.delisted });
        if (!p.delisted) await markDelisted(username, p.id, r.delisted);
      } else if (compareVersions(r.listed.entry.version, p.version) > 0) {
        rows.push({ id: p.id, installed: p.version, latest: r.listed.entry.version });
      }
    }
    return c.json(rows);
  })
  /** Install (or update to) the latest listed version, checked here again before anything is copied. */
  .post("/:id/install", async (c) => {
    const user = c.get("user");
    if (cantSave(user)) return c.json({ error: "Sign in to install packs" }, 403);
    if (!env.packCatalogUrl) return c.json(OFF, 404);
    const r = await resolve(c.req.param("id")).catch(() => "down" as const);
    if (r === "down") return c.json(DOWN, 502);
    if (!r) return c.json({ error: "Not in the catalog" }, 404);
    if ("delisted" in r) return c.json({ error: "This pack was removed from the catalog", reason: r.delisted }, 410);
    const check = checkPack(r.listed.pack);
    if (!check.ok || !check.pack) return c.json({ error: "This pack didn't pass the checks", problems: check.problems }, 400);
    const out = await installPack(user.username, check.pack, check.level ?? 0, { projectIds: parseProjectIds(await c.req.json().catch(() => null)) });
    const result: CatalogInstallResult = { installed: out.installed, kept: out.kept };
    return c.json(result, 201);
  })
  /** Publishing happens on the catalog's own site: answer with where. */
  .post("/submit", (c) => {
    if (cantSave(c.get("user"))) return c.json({ error: "Sign in to publish packs" }, 403);
    return c.json({ error: "This server only reads the community catalog. Publish on the catalog's site.", publishAt: base() || "https://creatortoolset.com" }, 409);
  });
