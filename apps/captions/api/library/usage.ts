import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";
import path from "node:path";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { CreateBucketCommand, GetBucketCorsCommand, HeadBucketCommand, PutBucketCorsCommand } from "@aws-sdk/client-s3";
import { BUNNY_REGIONS, type LibraryStorage, type LibraryStorageInput } from "../../contracts/library";
import { libraryRole } from "./access";
import { libraryDb, placeOf, serverBucket, type BunnyConfig, type StorageConfig } from "./db";
import { bunnyBlobs, createBunnyZone } from "./storage/bunny";
import { s3Blobs, s3Client, type S3Place } from "./storage/s3";
import type { BlobStore } from "./storage/types";
import { limitsFor } from "../lib/workspace-limits";

/**
 * Where a library keeps its files, and how much its bucket holds (tasks/media-library-plan.md, sections 3 and 7).
 * The workspace owner chooses: the server's disk (default), the server's bucket, the library's own S3-compatible
 * bucket with its own keys, or a Bunny Storage zone made from the owner's Bunny API key. Keys are stored in library.db (0600) and never sent back. Once the library holds files,
 * where they live stays put (moving them is a copy by key, not built); the keys can still change.
 */

export const storageApp = new Hono<{ Variables: AuthVars }>();

const db = () => libraryDb();

interface Row {
  storage_kind: "local" | "s3" | "bunny";
  storage_config: string | null;
  settings: string;
}

const rowOf = (libraryId: string) =>
  db().prepare("SELECT storage_kind, storage_config, settings FROM libraries WHERE id = ?").get(libraryId) as Row | undefined;
const configOf = (r: Row): StorageConfig | null => (r.storage_kind === "s3" ? (JSON.parse(r.storage_config ?? "{}") as StorageConfig) : null);
const zoneOf = (r: Row): BunnyConfig | null => (r.storage_kind === "bunny" ? (JSON.parse(r.storage_config ?? "{}") as BunnyConfig) : null);
/** Where a library's files are, as one string: two configs with the same place hold the same files. */
const placeKey = (kind: Row["storage_kind"], c: StorageConfig | BunnyConfig | null): string =>
  kind === "local" ? "local" : kind === "bunny" ? `bunny:${(c as BunnyConfig).zone}` : (c as StorageConfig).mode === "server" ? "s3:server" : `s3:${(c as StorageConfig).endpoint}/${(c as StorageConfig).bucket}`;
const holdsFiles = (libraryId: string) =>
  !!db().prepare("SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE a.library_id = ? LIMIT 1").get(libraryId);

function view(libraryId: string): LibraryStorage {
  const r = rowOf(libraryId)!;
  const c = configOf(r);
  const zone = zoneOf(r);
  const base = { kind: r.storage_kind, keysSet: false, serverBucket: !!serverBucket(), locked: holdsFiles(libraryId), days: [] };
  if (!c && !zone) return base;
  // ponytail: egress is not metered: playback is a 302 to the bucket, so the server never sees the bytes; the
  // provider's own bill has it
  const days = db()
    .prepare("SELECT day, stored_bytes AS storedBytes FROM usage_daily WHERE library_id = ? ORDER BY day DESC LIMIT 30")
    .all(libraryId) as { day: string; storedBytes: number }[];
  if (zone) return { ...base, zone: zone.zone, keysSet: !!zone.accessKey, storedBytes: days[0]?.storedBytes ?? 0, days };
  if (!c) return base;
  const own = c.mode === "own" ? { endpoint: c.endpoint ?? "", region: c.region ?? "", bucket: c.bucket ?? "", pathStyle: !!c.pathStyle } : {};
  return { ...base, mode: c.mode, ...own, keysSet: c.mode === "own" && !!c.accessKey && !!c.secretKey, storedBytes: days[0]?.storedBytes ?? 0, days };
}

/**
 * Bytes a library's workspace may still store, or null when no cap applies. Counts the bytes usage_daily meters
 * (bucket libraries only; a local-disk library reads as zero stored). No route calls it yet: an upload route asks
 * before it takes a file, once a build sets a cap through setLimitsHook().
 */
export function storageRoom(libraryId: string): number | null {
  const lib = db().prepare("SELECT workspace_id FROM libraries WHERE id = ?").get(libraryId) as { workspace_id: string } | undefined;
  const cap = lib ? limitsFor(lib.workspace_id).storageBytes : null;
  if (cap === null) return null;
  const stored = db().prepare("SELECT stored_bytes FROM usage_daily WHERE library_id = ? ORDER BY day DESC LIMIT 1").get(libraryId) as
    | { stored_bytes: number }
    | undefined;
  return Math.max(0, cap - (stored?.stored_bytes ?? 0));
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
  if (b?.kind !== "s3") return "Storage is local, s3 or bunny";
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

/** Writes and deletes a small file in the store, so a wrong key or name is said now, not at the first upload. */
async function tryStore(libraryId: string, store: BlobStore): Promise<string | null> {
  const staging = path.join(env.dataDir, "library", "staging");
  await mkdir(staging, { recursive: true });
  const file = path.join(staging, `check-${randomUUID()}`);
  await writeFile(file, "check");
  const key = `libraries/${libraryId}/check`;
  try {
    await store.put(key, file);
    await store.delete(key);
    return null;
  } catch (e) {
    return `The ${store.kind === "bunny" ? "storage zone" : "bucket"} did not take a test file: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    await rm(file, { force: true });
  }
}

const notFound = (e: unknown) => {
  const x = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return x.name === "NotFound" || x.name === "NoSuchBucket" || x.$metadata?.httpStatusCode === 404;
};

/**
 * Makes an own bucket that doesn't exist yet, and gives a bucket with no CORS rule the one direct uploads need (PUT from
 * the browser, ETag readable). A bucket that already has rules keeps them. A string is the error.
 * ponytail: a key that may not read or set CORS is let through; the first direct upload then fails in the browser
 */
async function prepareBucket(place: S3Place): Promise<string | null> {
  const client = s3Client(place);
  const Bucket = place.bucket;
  const missing = await client.send(new HeadBucketCommand({ Bucket })).then(() => false, notFound);
  if (missing) {
    // Amazon wants the region named for any region but its first; the other providers take it from the endpoint
    const where = !place.endpoint && place.region && place.region !== "us-east-1" ? { CreateBucketConfiguration: { LocationConstraint: place.region as never } } : {};
    const made = await client.send(new CreateBucketCommand({ Bucket, ...where })).then(
      () => null,
      (e: unknown) => `There is no bucket ${Bucket}, and it could not be made: ${e instanceof Error ? e.message : String(e)}`,
    );
    if (made) return made;
  }
  await client.send(new GetBucketCorsCommand({ Bucket })).catch((e: unknown) =>
    (e as { name?: string }).name === "NoSuchCORSConfiguration"
      ? client
          .send(
            new PutBucketCorsCommand({
              Bucket,
              CORSConfiguration: { CORSRules: [{ AllowedOrigins: ["*"], AllowedMethods: ["GET", "HEAD", "PUT"], AllowedHeaders: ["*"], ExposeHeaders: ["ETag"], MaxAgeSeconds: 3600 }] },
            }),
          )
          .catch(() => {})
      : undefined,
  );
  return null;
}

// GET /api/library/:id/usage → LibraryStorage; the owner only
storageApp.get("/:id/usage", (c) => {
  const libraryId = c.req.param("id");
  const role = libraryRole(c.get("user").username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  return c.json(view(libraryId));
});

// PUT /api/library/:id/storage LibraryStorageInput → LibraryStorage; the owner only
storageApp.put("/:id/storage", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return c.json({ error: "Not found", code: "not_found" }, 404);
  const r = rowOf(libraryId)!;
  const current = placeKey(r.storage_kind, configOf(r) ?? zoneOf(r));
  const body = (await c.req.json().catch(() => null)) as (Partial<LibraryStorageInput> & Record<string, unknown>) | null;
  const conflict = (error: string) => c.json({ error, code: "conflict" }, 409);
  const moving = "This library holds files, so where they live can't change. A new library can use the other storage.";
  const watch = (JSON.parse(r.settings || "{}") as { watch?: { mode: string }[] }).watch ?? [];
  const inPlace = "A bucket can't hold files left in their folders: remove the watch folders that do that first";

  if (body?.kind === "bunny") {
    if (r.storage_kind === "bunny" && !body.apiKey) return c.json(view(libraryId)); // already set up, nothing new
    if (holdsFiles(libraryId)) return conflict(moving);
    if (watch.some((f) => f.mode === "reference")) return conflict(inPlace);
    const apiKey = typeof body.apiKey === "string" && /^\S{10,200}$/.test(body.apiKey.trim()) ? body.apiKey.trim() : null;
    if (!apiKey) return c.json({ error: "Paste your Bunny account's API key", code: "invalid" }, 400);
    const region = BUNNY_REGIONS.find((x) => x.id === body.region)?.id ?? "DE";
    let zone: BunnyConfig;
    try {
      zone = await createBunnyZone(apiKey, region, (z) => tryStore(libraryId, bunnyBlobs(z, path.join(env.dataDir, "library", "cache"), { cacheBytes: 0 })));
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e), code: "invalid" }, 400);
    }
    db().prepare("UPDATE libraries SET storage_kind = 'bunny', storage_config = ? WHERE id = ?").run(JSON.stringify(zone), libraryId);
    return c.json(view(libraryId));
  }

  // a platform admin runs the server: they may point it at their own network
  const next = parse(body, configOf(r), !env.isProduction || user.role === "admin");
  if (typeof next === "string") return c.json({ error: next, code: "invalid" }, 400);
  if (current !== placeKey(next ? "s3" : "local", next) && holdsFiles(libraryId)) return conflict(moving);
  if (next && watch.some((f) => f.mode === "reference")) return conflict(inPlace);
  if (next) {
    const place = placeOf(next);
    if (!place) return c.json({ error: "The bucket is not set up", code: "invalid" }, 400);
    const failed =
      (next.mode === "own" ? await prepareBucket(place) : null) ??
      (await tryStore(libraryId, s3Blobs(s3Client(place), place.bucket, path.join(env.dataDir, "library", "cache"), { cacheBytes: 0 })));
    if (failed) return c.json({ error: failed, code: "invalid" }, 400);
  }
  db().prepare("UPDATE libraries SET storage_kind = ?, storage_config = ? WHERE id = ?").run(next ? "s3" : "local", next ? JSON.stringify(next) : null, libraryId);
  return c.json(view(libraryId));
});
