import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { AuthVars } from "../auth";
import { env } from "../lib/env";
import { sendFile } from "../lib/send-file";
import { canManage } from "../lib/workspaces";
import type { AssetCard, ShareCreated, ShareInput, ShareRow, SharedItem, SharedView } from "../../contracts/library";
import { libraryRole } from "./access";
import { blobs, libraryDb } from "./db";
import { savedQuery } from "./collections";
import { mediaFile } from "./routes";
import { buildAssetQuery, CARD, MAX_LIMIT, pageOf, toCard, type CardRow } from "./query";

/**
 * Share links (tasks/media-library-plan.md, section 9). A link is a random token shown once; the database keeps only its
 * sha256. A link shows one asset, one version or a collection, and nothing else in the library. Scopes: view (the
 * player) and download (plus the original). Expiry and an optional password (scrypt); the password unlock is a cookie
 * scoped to the link's path. Comment links come with Review (S9).
 *
 * `shareApp` is for members (mounted at /api/library); `publicShareApp` needs no account and is listed in
 * api/boot.ts's public paths next to the Review share links.
 */

export const shareApp = new Hono<{ Variables: AuthVars }>();
export const publicShareApp = new Hono<{ Variables: AuthVars }>();
type Ctx = Context<{ Variables: AuthVars }>;

const DAY = 86_400_000;
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const db = () => libraryDb();
const notFound = (c: Context) => c.json({ error: "Not found", code: "not_found" }, 404);
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const scryptAsync = promisify(scrypt);

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scryptAsync(pw, salt, 32) as Buffer).toString("hex")}`;
}

async function checkPassword(pw: string, stored: string): Promise<boolean> {
  const [, salt = "", hex = ""] = stored.split("$");
  const want = Buffer.from(hex, "hex");
  const got = (await scryptAsync(pw, Buffer.from(salt, "hex"), want.length)) as Buffer;
  return got.length === want.length && timingSafeEqual(got, want);
}

interface ShareDb {
  token_hash: string;
  library_id: string;
  target_kind: "asset" | "version" | "collection";
  target_id: string;
  scope: "view" | "download" | "comment";
  password_hash: string | null;
  created_by: string;
  expires_at: number;
  views: number;
}

/** The target is still there for the library: an asset not in the trash, a version of one, a collection. */
function targetExists(libraryId: string, kind: string, id: string): boolean {
  const sql =
    kind === "asset"
      ? "SELECT 1 FROM assets WHERE id = ? AND library_id = ? AND trashed_at IS NULL"
      : kind === "version"
        ? "SELECT 1 FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ? AND a.library_id = ? AND a.trashed_at IS NULL"
        : "SELECT 1 FROM collections WHERE id = ? AND library_id = ?";
  return !!db().prepare(sql).get(id, libraryId);
}

/** The live share behind a link: not expired, not revoked (its row is gone), and its target still in the library. */
function liveShare(token: string): ShareDb | null {
  if (!TOKEN_RE.test(token)) return null;
  const s = db().prepare("SELECT * FROM shares WHERE token_hash = ?").get(sha256(token)) as ShareDb | undefined;
  if (!s || s.expires_at <= Date.now() || !targetExists(s.library_id, s.target_kind, s.target_id)) return null;
  return s;
}

function shareName(s: ShareDb): string {
  const sql =
    s.target_kind === "asset"
      ? "SELECT title FROM assets WHERE id = ?"
      : s.target_kind === "version"
        ? "SELECT a.title AS title FROM asset_versions v JOIN assets a ON a.id = v.asset_id WHERE v.id = ?"
        : "SELECT name AS title FROM collections WHERE id = ?";
  return (db().prepare(sql).get(s.target_id) as { title: string } | undefined)?.title ?? "";
}

/** The cards a link shows, read from the database each time: a collection's current members, or the smart query. */
function sharedCards(s: ShareDb): AssetCard[] {
  const d = db();
  if (s.target_kind === "asset") {
    return (d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.id = a.current_version_id WHERE a.id = ? AND a.trashed_at IS NULL`).all(s.target_id) as unknown as CardRow[]).map(toCard);
  }
  if (s.target_kind === "version") {
    return (d.prepare(`SELECT ${CARD} FROM assets a JOIN asset_versions v ON v.asset_id = a.id WHERE v.id = ? AND a.trashed_at IS NULL`).all(s.target_id) as unknown as CardRow[]).map(toCard);
  }
  const col = d.prepare("SELECT kind, query FROM collections WHERE id = ?").get(s.target_id) as { kind: string; query: string | null };
  if (col.kind === "smart") {
    const { sql, params, limit } = buildAssetQuery(s.library_id, { ...savedQuery(JSON.parse(col.query ?? "{}")), limit: MAX_LIMIT });
    return pageOf(d.prepare(sql).all(...params) as unknown as CardRow[], limit).items;
  }
  return (
    d.prepare(
      `SELECT ${CARD} FROM collection_items ci JOIN assets a ON a.id = ci.asset_id JOIN asset_versions v ON v.id = a.current_version_id
       WHERE ci.collection_id = ? AND a.trashed_at IS NULL ORDER BY ci.position LIMIT ?`,
    ).all(s.target_id, MAX_LIMIT) as unknown as CardRow[]
  ).map(toCard);
}

/** A card as a link's visitor sees it: media URLs on the share route, the original only with scope download. */
function sharedItem(c: AssetCard, token: string, download: boolean): SharedItem {
  const base = `/api/library/s/${token}/media/${c.versionId}`;
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    versionId: c.versionId,
    ...(c.durationS ? { durationS: c.durationS } : {}),
    ...(c.width ? { width: c.width, height: c.height } : {}),
    ...(c.thumbUrl ? { thumbUrl: `${base}/thumb` } : {}),
    playUrl: `${base}/play`,
    ...(download ? { sourceUrl: `${base}/source` } : {}),
  };
}

// The unlock cookie: an HMAC over the share's hash and its password hash, so changing the password locks everyone out.
const unlockName = (tokenHash: string) => `ctl_share_${tokenHash.slice(0, 16)}`;
const unlockValue = (s: ShareDb) => createHmac("sha256", env.appSecret).update(`${s.token_hash}:${s.password_hash}`).digest("hex");
const unlocked = (c: Context, s: ShareDb) => !s.password_hash || getCookie(c, unlockName(s.token_hash)) === unlockValue(s);

// ---------- members ----------

// POST /api/library/:id/shares { target, scope, expiresInDays?, password? } → 201 ShareCreated (any member; the token once)
shareApp.post("/:id/shares", async (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  if (!libraryRole(user.username, libraryId)) return notFound(c);
  const body = (await c.req.json().catch(() => null)) as Partial<ShareInput> | null;
  const target = body?.target;
  if (!target || !["asset", "version", "collection"].includes(target.kind) || typeof target.id !== "string") {
    return c.json({ error: "Say what to share", code: "invalid" }, 400);
  }
  if (body?.scope !== "view" && body?.scope !== "download") {
    return c.json({ error: "A link is view or download; comment links come with Review", code: "invalid" }, 400);
  }
  const days = body.expiresInDays === undefined ? 7 : body.expiresInDays;
  if (!Number.isInteger(days) || days < 1 || days > 90) return c.json({ error: "Expiry is 1 to 90 days", code: "invalid" }, 400);
  const password = typeof body.password === "string" && body.password !== "" ? body.password : null;
  if (password && password.length > 200) return c.json({ error: "Password is too long", code: "invalid" }, 400);
  if (!targetExists(libraryId, target.kind, target.id)) return notFound(c);

  const token = randomBytes(16).toString("base64url");
  const tokenHash = sha256(token);
  const expiresAt = Date.now() + days * DAY;
  db()
    .prepare(
      `INSERT INTO shares (token_hash, library_id, target_kind, target_id, scope, password_hash, created_by, expires_at, views)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(tokenHash, libraryId, target.kind, target.id, body.scope, password ? await hashPassword(password) : null, user.username, expiresAt);
  const created: ShareCreated = { id: tokenHash, token, url: `/library/s/${token}`, expiresAt };
  return c.json(created, 201);
});

// GET /api/library/:id/shares → the live links: all of them for the owner, the caller's own for a member
shareApp.get("/:id/shares", (c) => {
  const user = c.get("user");
  const libraryId = c.req.param("id");
  const role = libraryRole(user.username, libraryId);
  if (!role) return notFound(c);
  const rows = db()
    .prepare("SELECT * FROM shares WHERE library_id = ? AND expires_at > ? AND (? = 1 OR created_by = ?) ORDER BY expires_at DESC")
    .all(libraryId, Date.now(), canManage(role) ? 1 : 0, user.username) as unknown as ShareDb[];
  const shares: ShareRow[] = rows.map((r) => ({
    id: r.token_hash,
    target: { kind: r.target_kind, id: r.target_id },
    scope: r.scope,
    locked: !!r.password_hash,
    createdBy: r.created_by,
    expiresAt: r.expires_at,
    views: r.views,
  }));
  return c.json({ shares });
});

// DELETE /api/library/shares/:tokenHash → revoke (the creator or the owner); the link is 404 from then on
shareApp.delete("/shares/:tokenHash", (c) => {
  const user = c.get("user");
  const s = db().prepare("SELECT library_id, created_by FROM shares WHERE token_hash = ?").get(c.req.param("tokenHash")) as
    | { library_id: string; created_by: string }
    | undefined;
  const role = s ? libraryRole(user.username, s.library_id) : null;
  if (!s || !role) return notFound(c);
  if (!canManage(role) && s.created_by !== user.username) return c.json({ error: "Only the creator or the owner can revoke it", code: "forbidden" }, 403);
  db().prepare("DELETE FROM shares WHERE token_hash = ?").run(c.req.param("tokenHash"));
  return c.json({ ok: true });
});

// ---------- the link holder (no account) ----------

// GET /api/library/s/:token → the shared view; locked (no items) until the password is given
publicShareApp.get("/s/:token", (c) => {
  const token = c.req.param("token");
  const s = liveShare(token);
  if (!s) return notFound(c);
  if (!unlocked(c, s)) return c.json({ locked: true, items: [] } satisfies SharedView);
  db().prepare("UPDATE shares SET views = views + 1 WHERE token_hash = ?").run(s.token_hash);
  const view: SharedView = {
    locked: false,
    name: shareName(s),
    scope: s.scope,
    items: sharedCards(s).map((card) => sharedItem(card, token, s.scope === "download")),
  };
  return c.json(view);
});

// POST /api/library/s/:token/unlock { password } → 204 and the unlock cookie; 403 for a wrong password; 429 after
// too many wrong ones on the link (MAX_WRONG in WINDOW_MS, counted in this process: ponytail, a shared store
// when there is more than one server process)
const MAX_WRONG = 10;
const WINDOW_MS = 15 * 60_000;
const wrong = new Map<string, { n: number; resetAt: number }>();

publicShareApp.post("/s/:token/unlock", async (c) => {
  const token = c.req.param("token");
  const s = liveShare(token);
  if (!s) return notFound(c);
  if (!s.password_hash) return c.body(null, 204);
  const tries = wrong.get(s.token_hash);
  if (tries && tries.resetAt > Date.now() && tries.n >= MAX_WRONG) {
    return c.json({ error: "Too many wrong passwords; try again later", code: "rate_limited" }, 429);
  }
  const body = (await c.req.json().catch(() => null)) as { password?: unknown } | null;
  const pw = typeof body?.password === "string" ? body.password : "";
  if (!pw || !(await checkPassword(pw, s.password_hash))) {
    const live = tries && tries.resetAt > Date.now() ? tries : { n: 0, resetAt: Date.now() + WINDOW_MS };
    live.n += 1;
    wrong.set(s.token_hash, live);
    return c.json({ error: "Wrong password", code: "forbidden" }, 403);
  }
  wrong.delete(s.token_hash);
  setCookie(c, unlockName(s.token_hash), unlockValue(s), {
    httpOnly: true,
    sameSite: "Lax",
    path: `/api/library/s/${token}`,
    maxAge: Math.max(0, Math.floor((s.expires_at - Date.now()) / 1000)),
    secure: env.isProduction,
  });
  return c.body(null, 204);
});

// GET /api/library/s/:token/media/:versionId/:kind → thumb | play | source (source only with scope download)
publicShareApp.get("/s/:token/media/:versionId/:kind", async (c) => {
  const token = c.req.param("token");
  const s = liveShare(token);
  if (!s || !unlocked(c, s)) return notFound(c);
  const versionId = c.req.param("versionId");
  const kind = c.req.param("kind");
  if (kind === "source" && s.scope !== "download") return notFound(c);
  // ponytail: the link's items are read per request; a direct membership query when a collection grows large
  if (!sharedCards(s).some((card) => card.versionId === versionId)) return notFound(c);
  const file = mediaFile(versionId, kind);
  if (!file) return notFound(c);
  if (!file.key) return c.json({ error: "Not ready", code: "conflict" }, 409);
  const name = kind === "source" ? `${shareName(s).replace(/[^\w .-]/g, "_").slice(0, 120) || "download"}` : undefined;
  try {
    return await sendFile(c, await blobs.localCopy(file.key), file.type, name);
  } catch {
    return c.json({ error: "Not ready", code: "conflict" }, 409);
  }
});
