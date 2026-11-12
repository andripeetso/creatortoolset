import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The community catalog's read side: browse, detail, install, update and delisting notices come from the shared
// catalog (fetch stubbed here), publishing answers with its address, and an empty PACK_CATALOG_URL turns it off.
process.env.DATA_DIR = mkdtempSync(path.join(tmpdir(), "pack-catalog-"));
process.env.PACK_CATALOG_URL = "https://catalog.example";

const { Hono } = await import("hono");
const { env } = await import("./lib/env");
const { packCatalogApp } = await import("./pack-catalog");
const { listInstalled, packInstructions } = await import("./lib/packs");

let me: Record<string, unknown> = { username: "tinyacrobatics", role: "user", cloud: true, off: [] };
const app = new Hono<{ Variables: { user: unknown } }>();
app.use("*", async (c, next) => { c.set("user", me); await next(); });
app.route("/api/pack-catalog", packCatalogApp as never);
const call = (method: string, url: string, body?: unknown) =>
  app.request(url, { method, headers: { "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

const pack = (version: string) => ({
  format: 1, id: "punchy-hooks", name: "Punchy Hooks", version, author: "Tiny Acrobatics", license: "CC-BY-4.0",
  description: "Short hooks for fitness reels.", instructions: { "workshop.write": "Open on the result, then show the work." },
});
const detail = (version: string) => ({
  entry: { id: "punchy-hooks", name: "Punchy Hooks", version, author: "Tiny Acrobatics", license: "CC-BY-4.0", description: "Short hooks.",
    level: 0, official: false, installs: 3, publishedAt: 1, contains: { instructions: ["workshop.write"], frameworks: 0, captionStyles: 0, designSystems: 0 } },
  pack: pack(version),
  versions: [version],
});

/** The shared catalog: answers per path, everything else 404. */
let hosted: Record<string, () => Response> = {};
const seen: string[] = [];
vi.stubGlobal("fetch", async (url: string) => {
  const u = new URL(url);
  seen.push(u.origin + u.pathname);
  return hosted[u.pathname]?.() ?? new Response("{}", { status: 404 });
});
afterEach(() => {
  me = { username: "tinyacrobatics", role: "user", cloud: true, off: [] };
  env.packCatalogUrl = "https://catalog.example";
});

describe("community catalog", () => {
  it("browse and detail come from the shared catalog", async () => {
    hosted = {
      "/api/pack-catalog/public": () => Response.json([detail("1.0.0").entry]),
      "/api/pack-catalog/public/punchy-hooks": () => Response.json(detail("1.0.0")),
    };
    const list = (await (await call("GET", "/api/pack-catalog/public?q=hooks")).json()) as Array<{ id: string }>;
    expect(list.map((e) => e.id)).toEqual(["punchy-hooks"]);
    expect(seen).toContain("https://catalog.example/api/pack-catalog/public");
    expect((await call("GET", "/api/pack-catalog/public/punchy-hooks")).status).toBe(200);
    expect((await call("GET", "/api/pack-catalog/public/nope-pack")).status).toBe(404);
  });

  it("installs the listed version, then shows a newer one as an update", async () => {
    const res = await call("POST", "/api/pack-catalog/punchy-hooks/install");
    expect(res.status).toBe(201);
    expect((await listInstalled("tinyacrobatics")).map((p) => p.version)).toEqual(["1.0.0"]);

    hosted["/api/pack-catalog/public/punchy-hooks"] = () => Response.json(detail("1.1.0"));
    expect(await (await call("GET", "/api/pack-catalog/updates")).json()).toEqual([{ id: "punchy-hooks", installed: "1.0.0", latest: "1.1.0" }]);
  });

  it("a delisted pack is flagged and its instructions stop", async () => {
    expect(await packInstructions("tinyacrobatics", "workshop.write", null)).toContain("Punchy Hooks");
    hosted["/api/pack-catalog/public/punchy-hooks"] = () => Response.json({ error: "gone", reason: "Copied text" }, { status: 410 });
    const rows = (await (await call("GET", "/api/pack-catalog/updates")).json()) as Array<{ delisted?: string }>;
    expect(rows[0].delisted).toBe("Copied text");
    expect((await listInstalled("tinyacrobatics"))[0].delisted).toBe("Copied text");
    expect(await packInstructions("tinyacrobatics", "workshop.write", null)).toBe("");
    expect((await call("POST", "/api/pack-catalog/punchy-hooks/install")).status).toBe(410);
  });

  it("installs no pack that carries code, whatever the catalog lists", async () => {
    const kit = { ...pack("1.0.0"), permissions: ["motion-kit"], designSystems: [{ name: "tiny-look", title: "Tiny look", tokens: {}, guide: "Soft.", kit: "export const draw = () => {}" }] };
    hosted = { "/api/pack-catalog/public/punchy-hooks": () => Response.json({ ...detail("1.0.0"), pack: kit }) };
    const res = await call("POST", "/api/pack-catalog/punchy-hooks/install");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/carries code/);
  });

  it("installs no pack with a skill for the assistant, whatever the catalog lists", async () => {
    const dock = { ...pack("1.0.0"), skills: [{ slot: "assistant", name: "Hooks", text: "Open on the result." }] };
    hosted = { "/api/pack-catalog/public/punchy-hooks": () => Response.json({ ...detail("1.0.0"), pack: dock }) };
    const res = await call("POST", "/api/pack-catalog/punchy-hooks/install");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { problems: string[] }).problems).toContain("skills[0].slot: a shared skill never goes to the assistant");
    expect((await listInstalled("tinyacrobatics")).some((p) => p.skills?.length)).toBe(false);
  });

  it("publishing answers with the catalog's address; share-link visitors can't install or publish", async () => {
    const res = await call("POST", "/api/pack-catalog/submit", { pack: pack("2.0.0"), rights: true });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { publishAt: string }).publishAt).toBe("https://catalog.example");
    me = { username: "visitor", role: "visitor", cloud: true, off: [] };
    expect((await call("POST", "/api/pack-catalog/punchy-hooks/install")).status).toBe(403);
    expect((await call("POST", "/api/pack-catalog/submit", { pack: pack("2.0.0") })).status).toBe(403);
  });

  it("the author's own submissions are on the catalog's site, with its address", async () => {
    me = { username: "tinyacrobatics", role: "user", cloud: true, off: [] };
    const res = await call("GET", "/api/pack-catalog/mine");
    expect(res.status).toBe(409);
    expect(((await res.json()) as { publishAt: string }).publishAt).toBe("https://catalog.example");
  });

  it("an empty PACK_CATALOG_URL turns it off and asks nothing", async () => {
    env.packCatalogUrl = "";
    seen.length = 0;
    expect((await call("GET", "/api/pack-catalog/public")).status).toBe(404);
    expect((await call("POST", "/api/pack-catalog/punchy-hooks/install")).status).toBe(404);
    expect(await (await call("GET", "/api/pack-catalog/updates")).json()).toEqual([]);
    expect(seen).toEqual([]);
  });

  it("a catalog that can't be reached is a 502", async () => {
    vi.stubGlobal("fetch", async () => { throw new Error("offline"); });
    expect((await call("GET", "/api/pack-catalog/public")).status).toBe(502);
    expect((await call("GET", "/api/pack-catalog/public/punchy-hooks")).status).toBe(502);
  });
});
