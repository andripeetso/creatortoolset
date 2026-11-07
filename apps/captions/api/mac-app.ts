import { readFile, mkdir, rename, rm, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { Hono } from "hono";
import { env } from "./lib/env";
import type { AuthVars } from "./auth";

/**
 * The Creator Toolset Mac app's download and updates. A release is a zip of the app, signed for Sparkle (EdDSA),
 * and it is PUT here with an admin's access key; the site keeps the latest in $DATA_DIR/mac-app/ and serves it, and
 * Sparkle in the app reads the appcast. The GETs are public (mounted before the account gate in boot.ts).
 */

export interface MacRelease {
  version: string;
  build: number;
  size: number;
  /** Sparkle's sparkle:edSignature of the zip */
  signature: string;
  at: number;
}

const DIR = () => path.join(env.dataDir, "mac-app");
const zipOf = (build: number) => path.join(DIR(), `CreatorToolset-${build}.zip`);

async function latest(): Promise<MacRelease | null> {
  try {
    return JSON.parse(await readFile(path.join(DIR(), "latest.json"), "utf-8")) as MacRelease;
  } catch {
    return null;
  }
}

const esc = (s: string) => s.replace(/[<>&"]/g, (ch) => `&#${ch.charCodeAt(0)};`);

export const macAppPublic = new Hono()
  .get("/", async (c) => c.json(await latest()))
  .get("/download", async (c) => {
    const r = await latest();
    if (!r) return c.json({ error: "No Mac app yet" }, 404);
    return c.redirect(`/api/mac-app/download/${r.build}.zip`);
  })
  .get("/download/:file{[0-9]+\\.zip}", async (c) => {
    const build = Number(c.req.param("file").replace(".zip", ""));
    let bytes: Buffer;
    try {
      bytes = await readFile(zipOf(build));
    } catch {
      return c.json({ error: "Not found" }, 404);
    }
    return c.body(new Uint8Array(bytes), 200, {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="Creator Toolset.zip"`,
      "cache-control": "public, max-age=86400, immutable",
    });
  })
  .get("/appcast.xml", async (c) => {
    const r = await latest();
    const host = c.req.header("host") ?? "localhost";
    const origin =
      process.env.PUBLIC_ORIGIN?.replace(/\/$/, "") ||
      `${c.req.header("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https")}://${host}`;
    const item = r
      ? `<item><title>Version ${esc(r.version)}</title><pubDate>${new Date(r.at).toUTCString()}</pubDate>` +
        `<sparkle:version>${r.build}</sparkle:version><sparkle:shortVersionString>${esc(r.version)}</sparkle:shortVersionString>` +
        `<sparkle:minimumSystemVersion>14.0</sparkle:minimumSystemVersion>` +
        `<enclosure url="${esc(`${origin}/api/mac-app/download/${r.build}.zip`)}" length="${r.size}" type="application/octet-stream" sparkle:edSignature="${esc(r.signature)}"/></item>`
      : "";
    return c.body(
      `<?xml version="1.0" encoding="utf-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>Creator Toolset</title>${item}</channel></rss>\n`,
      200,
      { "content-type": "application/xml; charset=utf-8", "cache-control": "no-cache" },
    );
  });

/** PUT /api/mac-app/release?version=&build=&signature= with the zip as the body. Admins only (cookie or access key). */
export const macAppRelease = new Hono<{ Variables: AuthVars }>().put("/release", async (c) => {
  if (c.get("user")?.role !== "admin") return c.json({ error: "Admins only" }, 403);
  const version = c.req.query("version") ?? "";
  const build = Number(c.req.query("build"));
  const signature = c.req.query("signature") ?? "";
  if (!/^[0-9][0-9.]{0,20}$/.test(version) || !Number.isInteger(build) || build < 1 || !/^[A-Za-z0-9+/=]{40,200}$/.test(signature)) {
    return c.json({ error: "version, build and signature please" }, 400);
  }
  const prev = await latest();
  if (prev && build <= prev.build) return c.json({ error: `Build ${build} is not newer than ${prev.build}` }, 409);
  const bytes = new Uint8Array(await c.req.arrayBuffer());
  if (bytes.length < 1000 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return c.json({ error: "Not a zip" }, 400);

  await mkdir(DIR(), { recursive: true });
  await writeFile(`${zipOf(build)}.tmp`, bytes);
  await rename(`${zipOf(build)}.tmp`, zipOf(build));
  const release: MacRelease = { version, build, size: bytes.length, signature, at: Date.now() };
  await writeFile(path.join(DIR(), "latest.json.tmp"), JSON.stringify(release, null, 2));
  await rename(path.join(DIR(), "latest.json.tmp"), path.join(DIR(), "latest.json"));
  // keep this one and the one before (an app mid-update may still be fetching it)
  for (const f of await readdir(DIR())) {
    const m = /^CreatorToolset-(\d+)\.zip$/.exec(f);
    if (m && Number(m[1]) !== build && Number(m[1]) !== prev?.build) await rm(path.join(DIR(), f), { force: true });
  }
  return c.json(release);
});
