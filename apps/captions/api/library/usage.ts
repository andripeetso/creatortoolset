import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { canManage } from "../lib/workspaces";
import type { LibraryStorage, LibraryStorageInput } from "../../contracts/library";
import { libraryRole } from "./access";
import { libraryDb, placeOf, serverBucket, type StorageConfig } from "./db";
import { s3Blobs, s3Client } from "./storage/s3";

/**
 * Where a library keeps its files, and how much its bucket holds (tasks/media-library-plan.md, sections 3 and 7).
 * The workspace owner chooses: the server's disk (default), the server's bucket, or the library's own S3-compatible
 * bucket with its own keys. Keys are stored in library.db (0600) and never sent back. Once the library holds files,
 * where they live stays put (moving them is a copy by key, not built); the keys can still change.
 */

export const storageApp = new Hono<{ Variables: AuthVars }>();

const db = () => libraryDb();

interface Row {
  storage_kind: "local" | "s3";
  storage_config: string | null;
  settings: string;
}

const rowOf = (libraryId: string) =>
  db().prepare("SELECT storage_kind, storage_config, settings FROM libraries WHERE id = ?").get(libraryId) as Row | undefined;
const configOf = (r: Row): StorageConfig | null => (r.storage_kind === "s3" ? (JSON.parse(r.storage_config ?? "{}") as StorageConfig) : null);
const holdsFiles = (libraryId: string) =>
  !!db().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? LIMIT 1").get(libraryId);

function view(libraryId: string): LibraryStorage {
  const r = rowOf(libraryId)!;
  const c = configOf(r);
  const base = { kind: r.storage_kind, keysSet: false, serverBucket: !!serverBucket(), locked: holdsFiles(libraryId), days: [] };
  if (!c) return base;
  // ponytail: egress is not metered: playback is a 302 to the bucket, so the server never sees the bytes; the
  // provider's own bill has it
  const days = db()
    .prepare("SELECT day, stored_bytes AS storedBytes FROM usage_daily WHERE library_id = ? ORDER BY day DESC LIMIT 30")
    .all(libraryId) as { day: string; storedBytes: number }[];
  const own = c.mode === "own" ? { endpoint: c.endpoint ?? "", region: c.region ?? "", bucket: c.bucket ?? "", pathStyle: !!c.pathStyle } : {};
  return { ...base, mode: c.mode, ...own, keysSet: c.mode === "own" && !!c.accessKey && !!c.secretKey, storedBytes: days[0]?.storedBytes ?? 0, days };
}

// addresses a hosted server must not be pointed at: its own machine and private networks (the URL parser has already
// turned any IPv4 spelling into dotted decimal)
const PRIVATE_V6 = new BlockList();
for (const [a, n] of [["::", 127], ["::ffff:0:0", 96], ["fc00::", 7], ["fe80::", 10]] as const) PRIVATE_V6.addSubnet(a, n, "ipv6");
const privateV4 = (host: string) => {
  const [a, b] = host.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b < 128) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168);
};

/**
 * An own bucket's endpoint, or an error. On a production server only its admin may name http or a private address.
 * ponytail: a DNS name that resolves to a private address is not caught; resolve and pin it if a hosted server needs that
 */
function checkEndpoint(raw: string, trusted: boolean): string | { error: string } {
  if (!raw) return ""; // the SDK's default: AWS, by region
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { error: "The endpoint is a URL, like https://s3.example.com" };
  }
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search) return { error: "The endpoint is the server's address only" };
  if (trusted) return u.origin;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const ip = isIP(host);
  if (u.protocol !== "https:") return { error: "The endpoint must use https" };
  if (host === "localhost" || host.endsWith(".localhost") || (ip === 4 && privateV4(host)) || (ip === 6 && PRIVATE_V6.check(host, "ipv6"))) {
    return { error: "That endpoint is a private address" };
  }
  return u.origin;
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.trim().length <= max ? v.trim() : null);

/** The config a PUT asks for, merged with the saved keys when it leaves them out. A string is the error. */
function parse(b: Partial<Record<string, unknown>> | null, current: StorageConfig | null, trusted: boolean): StorageConfig | null | string {
  if (b?.kind === "local") return null;
  if (b?.kind !== "s3") return "Storage is local or s3";
  if (b.mode === "server") return serverBucket() ? { mode: "server" } : "This server has no bucket for libraries";
  if (b.mode !== "own") return "The bucket is the server's or your own";
  const endpoint = checkEndpoint(str(b.endpoint, 300) ?? "", trusted);
  if (typeof endpoint !== "string") return endpoint.error;
  const bucket = str(b.bucket, 63) ?? "";
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return "Bucket names are 3 to 63 lowercase letters, digits, dots and dashes";
  const region = str(b.region, 40) ?? "";
  if (!/^[a-z0-9-]*$/.test(region)) return "The region is like us-east-1";
  const key = (v: unknown, saved?: string) => (v === undefined || v === "" ? saved : typeof v === "string" && /^\S{1,200}$/.test(v) ? v : null);
  const keep = current?.mode === "own" ? current : undefined;
  const accessKey = key(b.accessKey, keep?.accessKey);
  const secretKey = key(b.secretKey, keep?.secretKey);
  if (!accessKey || !secretKey) return "Paste the bucket's access key and secret key (one line each)";
  return { mode: "own", endpoint, region, bucket, pathStyle: b.pathStyle === true, accessKey, secretKey };
}

const sameStore = (a: StorageConfig | null, b: StorageConfig | null) =>
  a === null || b === null ? a === b : a.mode === b.mode && (a.mode === "server" || (a.endpoint === b.endpoint && a.bucket === b.bucket));

/** Writes and deletes a small file in the bucket, so a wrong key or name is said now, not at the first upload. */
async function tryBucket(libraryId: string, c: StorageConfig): Promise<string | null> {
  const place = placeOf(c);
  if (!place) return "The bucket is not set up";
  const staging = path.join(env.dataDir, "library", "staging");
  await mkdir(staging, { recursive: true });
  const file = path.join(staging, `check-${randomUUID()}`);
  await writeFile(file, "check");
  const store = s3Blobs(s3Client(place), place.bucket, path.join(env.dataDir, "library", "cache"), { cacheBytes: 0 });
  const key = `libraries/${libraryId}/check`;
  try {
    await store.put(key, file);
    await store.delete(key);
    return null;
  } catch (e) {
    return `The bucket did not take a test file: ${e instanceof Error ? e.message : String(e)}`;
  }
}

// GET /api/library/:id/usage → LibraryStorage; the owner only
storageApp.get("/:id/usage", (c) => {
  const libraryId = c.req.param("id");
  const role = libraryRole(c.get("user").username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!canManage(role)) return c.json({ error: "Only the owner sees the library's storage", code: "forbidden" }, 403);
  return c.json(view(libraryId));
});

// PUT /api/library/:id/storage LibraryStorageInput → LibraryStorage; the owner only
storageApp.put("/:id/storage", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  if (!canManage(role)) return c.json({ error: "Only the owner changes the library's storage", code: "forbidden" }, 403);
  const r = rowOf(libraryId)!;
  const current = configOf(r);
  const body = (await c.req.json().catch(() => null)) as (Partial<LibraryStorageInput> & Record<string, unknown>) | null;
  // a platform admin runs the server: they may point it at their own network
  const next = parse(body, current, !env.isProduction || user.role === "admin");
  if (typeof next === "string") return c.json({ error: next, code: "invalid" }, 400);
  if (!sameStore(current, next) && holdsFiles(libraryId)) {
    return c.json({ error: "This library holds files, so where they live can't change. A new library can use the other storage.", code: "conflict" }, 409);
  }
  const watch = (JSON.parse(r.settings || "{}") as { watch?: { mode: string }[] }).watch ?? [];
  if (next && watch.some((f) => f.mode === "reference")) {
    return c.json({ error: "A bucket can't hold files left in their folders: remove the watch folders that do that first", code: "conflict" }, 409);
  }
  if (next) {
    const failed = await tryBucket(libraryId, next);
    if (failed) return c.json({ error: failed, code: "invalid" }, 400);
  }
  db().prepare("UPDATE libraries SET storage_kind = ?, storage_config = ? WHERE id = ?").run(next ? "s3" : "local", next ? JSON.stringify(next) : null, libraryId);
  return c.json(view(libraryId));
});
