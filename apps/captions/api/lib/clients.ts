import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env";

// Phone connection contract types (api/connect/contract.md has the rules and the words). The store is below them.

/** What a client session may do: `read` = GET/HEAD, `write` = every other method, `access` = links, sessions, connect. */
export type Scope = "read" | "write" | "access";
export const SCOPES: readonly Scope[] = ["read", "write", "access"];
export const READ_ONLY: readonly Scope[] = ["read"];
export const STANDARD: readonly Scope[] = ["read", "write", "access"];

export type DeviceType = "desktop" | "mobile" | "tablet" | "bot" | "unknown";
export type SessionMethod = "bearer-access-token" | "dpop-access-token";

/** GET /.well-known/creator-toolset/server */
export interface ServerDescriptor {
  serverId: string;
  label: string;
  platform: "mac" | "linux" | "hosted";
  version: string;
  protocol: 1;
  /** `account`: takes an account ticket at /oauth/token (a hosted server that names an account sign-in service). */
  capabilities: { pairing: boolean; dpop: boolean; connect: boolean; account: boolean };
}

export interface PairingLinkUrl {
  kind: "public" | "lan" | "tailnet";
  url: string; // https://host/#token=XXXXXXXXXXXX
}

/** A pending pairing link as listed: never the credential. */
export interface PairingLink {
  id: string;
  subject: string;
  label?: string;
  scopes: Scope[];
  createdAt: string;
  expiresAt: string;
}

/** POST /api/auth/pairing-links: the only place the credential appears. */
export interface CreatedPairingLink extends PairingLink {
  credential: string;
  urls: PairingLinkUrl[];
}

export interface CreatePairingLinkInput {
  label?: string;
  scopes?: Scope[];
  /** the kind of device this link is for, said by the screen that makes it (default "unknown") */
  deviceType?: DeviceType;
}

export interface ClientMetadata {
  label?: string;
  deviceType: DeviceType;
  os?: string;
  model?: string;
  appVersion?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ClientSession {
  sessionId: string;
  subject: string;
  label?: string;
  scopes: Scope[];
  method: SessionMethod;
  client: ClientMetadata;
  issuedAt: string;
  expiresAt: string;
  lastConnectedAt: string | null;
  connected: boolean;
  current: boolean;
}

/** GET /api/auth/access */
export interface AccessSnapshot {
  pairingLinks: PairingLink[];
  clientSessions: ClientSession[];
}

/** GET /api/auth/access/events: each SSE event's data. */
export type AccessEvent = { version: 1; revision: number } & (
  | { type: "snapshot"; payload: AccessSnapshot }
  | { type: "pairingLinkUpserted"; payload: PairingLink }
  | { type: "pairingLinkRemoved"; payload: { id: string } }
  | { type: "clientUpserted"; payload: ClientSession }
  | { type: "clientRemoved"; payload: { sessionId: string } }
);

export const TOKEN_EXCHANGE_GRANT = "urn:ietf:params:oauth:grant-type:token-exchange";
export const BOOTSTRAP_TOKEN_TYPE = "urn:creatortoolset:params:oauth:token-type:server-bootstrap";
/** A ticket from the account sign-in service for a phone signed in to its account (contract.md, account tickets). */
export const ACCOUNT_TICKET_TOKEN_TYPE = "urn:creatortoolset:params:oauth:token-type:account-ticket";
export const ACCESS_TOKEN_TYPE = "urn:ietf:params:oauth:token-type:access_token";

/** POST /oauth/token answer. */
export interface AccessTokenResult {
  access_token: string;
  issued_token_type: typeof ACCESS_TOKEN_TYPE;
  token_type: "Bearer" | "DPoP";
  expires_in: number;
  scope: string;
}

export type TokenError = "unsupported_grant_type" | "invalid_request" | "invalid_dpop_proof" | "invalid_grant" | "invalid_scope";

/** 401 codes on /api/* for a token that doesn't work; BUSY is 503 (the device's key spent its share of proofs). */
export type SessionErrorCode = "INVALID_TOKEN" | "SESSION_EXPIRED" | "SESSION_REVOKED" | "INVALID_DPOP" | "BUSY";

/** GET /api/auth/session */
export interface SessionState {
  authenticated: boolean;
  scopes: Scope[];
  method: "browser-cookie" | SessionMethod | null;
  expiresAt: string | null;
  user: { username: string; name: string; role: string } | null;
}

/** GET /api/server/endpoints */
export interface ServerEndpoint {
  kind: "lan" | "tailnet";
  httpBaseUrl: string;
}

/** POST /api/connect/health, /api/connect/mint: the connect service's signed request. */
export interface ConnectRequest {
  proof: string;
}

export interface HealthProofPayload {
  iss: string;
  aud: string; // ct-computer:<serverId>
  sub: string; // the linked owner account id
  jti: string;
  iat: number;
  exp: number;
  nonce: string;
  scope: ["status"];
}

export interface MintProofPayload {
  iss: string;
  aud: string;
  sub: string;
  jti: string;
  iat: number;
  exp: number;
  nonce: string;
  clientProofKeyThumbprint: string;
  cnf: { jkt: string };
  deviceId?: string;
  scope: ["connect"];
}

export interface HealthAnswer {
  serverId: string;
  status: "online";
  checkedAt: string;
  descriptor: ServerDescriptor;
  proof: string;
}

export interface MintAnswer {
  credential: string;
  expiresAt: string;
  proof: string;
}

/** POST /api/connect/link-proof */
export interface LinkProofInput {
  challenge: string;
  relayUrl: string;
}
export interface LinkProofAnswer {
  proof: string;
  computerId: string;
  publicKey: string; // base64 SPKI DER
  origin: string;
  name: string;
}

/** POST /api/connect/relay-config */
export interface RelayConfigInput {
  brokerUrl: string;
  owner: string;
  computerId: string;
  hostname: string;
  tunnelToken: string;
  brokerKey: string; // base64 SPKI DER, Ed25519
  brokerKid?: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// The store: one-time grants (pairing links and connect credentials) and the client sessions they turn into. Kept in
// DATA_DIR/clients.json (mode 0600) with only the SHA-256 of each credential and token, so the file opens nothing.

export const PAIRING_TTL_MS = 5 * 60_000;
export const CONNECT_TTL_MS = 2 * 60_000;
export const BEARER_TTL_MS = 30 * 24 * 3600_000; // fixed: never extended
export const DPOP_TTL_MS = 3600_000;
const TOUCH_EVERY_MS = 60_000;

/** The pairing alphabet: no 0/O, 1/I/L, so a code read aloud or typed can't be mistaken. */
export const CREDENTIAL_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"; // gitleaks:allow (an alphabet, not a secret)
const CREDENTIAL_RE = /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
export const TOKEN_RE = /^cts_[A-Za-z0-9_-]{43}$/;

interface GrantRow {
  id: string;
  hash: string;
  kind: "pairing" | "connect";
  subject: string;
  label?: string;
  scopes: Scope[];
  jkt?: string; // a connect grant is redeemed only with a proof by this key
  deviceType?: DeviceType; // fixed by the link's maker; the session gets this, never the redeeming device's claim
  createdAt: number;
  expiresAt: number;
}

export interface SessionRow {
  id: string;
  hash: string;
  subject: string;
  scopes: Scope[];
  method: SessionMethod;
  jkt?: string;
  client: ClientMetadata;
  issuedAt: number;
  expiresAt: number;
  lastConnectedAt: number | null;
  revokedAt: number | null;
}

interface Store {
  grants: GrantRow[];
  sessions: SessionRow[];
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const iso = (ms: number) => new Date(ms).toISOString();
const file = () => path.join(env.dataDir, "clients.json");
let store: Store | null = null;
let readAs = ""; // the file as `store` was read from it: inode, mtime, size (a write by another process changes them)
let byHash: Map<string, SessionRow> | null = null; // sessions by token hash, for `store` as it is (dropped on any change)
const touched = new Map<string, number>(); // session id -> lastConnectedAt not written yet (flushTouches)

const fileStamp = () => {
  try {
    const st = statSync(file());
    return `${st.ino}:${st.mtimeMs}:${st.size}`;
  } catch {
    return "";
  }
};

/**
 * The store as the file holds it now. Two servers can run on one data dir for a moment (the no-downtime swap), so a
 * change written by the other is read here at the next request.
 */
function load(): Store {
  const now = fileStamp();
  if (store && now === readAs) return store;
  try {
    const s = JSON.parse(readFileSync(file(), "utf8")) as Partial<Store>;
    store = { grants: s.grants ?? [], sessions: s.sessions ?? [] };
  } catch {
    store = { grants: [], sessions: [] };
  }
  readAs = now;
  byHash = null;
  // requests seen here since the last flush still count
  for (const r of store.sessions) {
    const at = touched.get(r.id);
    if (at !== undefined && (r.lastConnectedAt ?? 0) < at) r.lastConnectedAt = at;
  }
  return store;
}

const sessionByHash = (hash: string): SessionRow | undefined => {
  const s = load();
  if (!byHash) byHash = new Map(s.sessions.map((r) => [r.hash, r]));
  return byHash.get(hash);
};

export const LOCK_STALE_MS = 10_000;
const pause = new Int32Array(new SharedArrayBuffer(4));

/** How long a change waits for the other server's write, blocking this one meanwhile: a write takes milliseconds. */
export const LOCK_WAIT_MS = 250;

/** Runs `fn` holding DATA_DIR/clients.json.lock (made with O_EXCL), so a change by one server never undoes another's. */
function locked<T>(fn: () => T): T {
  mkdirSync(env.dataDir, { recursive: true });
  const lock = `${file()}.lock`;
  for (let tries = 0; ; tries++) {
    try {
      closeSync(openSync(lock, "wx", 0o600));
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      // a write takes milliseconds: a lock this old was left by a server that died holding it
      // shortcut: two waiters can both clear one stale lock; fine while a holder dying mid-write is the only way to leave one
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch { /* gone already */ }
      if (tries * 5 >= LOCK_WAIT_MS) throw new Error("clients.json stayed locked");
      Atomics.wait(pause, 0, 0, 5);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** One change: under the lock, on the file as it is now, written back whole (temp file + rename) unless `wrote` says no. */
function change<T>(fn: (s: Store) => T, wrote: (out: T) => boolean = () => true): T {
  return locked(() => {
    store = null;
    const s = load();
    const out = fn(s);
    if (!wrote(out)) return out;
    byHash = null;
    const now = Date.now();
    // expired links go; a session goes once it expired and nothing holds a line open on it (a revoked one stays marked
    // until then, so its token is answered "signed out on the computer", not "unknown")
    s.grants = s.grants.filter((g) => g.expiresAt > now);
    s.sessions = s.sessions.filter((r) => r.expiresAt > now || (lines.get(r.id)?.size ?? 0) > 0);
    const tmp = `${file()}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
    renameSync(tmp, file());
    readAs = fileStamp();
    return out;
  });
}

/** Forget the store in memory (tests that swap DATA_DIR). */
export const resetClientsForTest = () => {
  store = null;
  readAs = "";
  byHash = null;
  touched.clear();
  lines.clear();
  listeners.clear();
};

/** 12 characters, each an unbiased pick from the alphabet (randomInt rejects the uneven tail). */
export const newCredential = (): string => Array.from({ length: 12 }, () => CREDENTIAL_ALPHABET[randomInt(CREDENTIAL_ALPHABET.length)]).join("");

/** A typed code as the store knows it: upper-case, spaces and dashes dropped. Null when it can't be one. */
export const normalizeCredential = (raw: string): string | null => {
  const c = raw.replace(/[\s-]/g, "").toUpperCase();
  return CREDENTIAL_RE.test(c) ? c : null;
};

export function parseScopes(raw: unknown): Scope[] | null {
  if (!Array.isArray(raw)) return null;
  if (!raw.every((s): s is Scope => SCOPES.includes(s as Scope))) return null;
  return SCOPES.filter((s) => raw.includes(s));
}

// ---- live events ----------------------------------------------------------------------------------------------------

export type StoreEvent =
  | { type: "pairingLinkUpserted"; link: PairingLink }
  | { type: "pairingLinkRemoved"; id: string; subject: string }
  | { type: "clientUpserted"; row: SessionRow }
  | { type: "clientRemoved"; sessionId: string; subject: string };
const listeners = new Set<(e: StoreEvent, revision: number) => void>();
let revision = 0;
export const accessRevision = () => revision;
export function onAccessChange(fn: (e: StoreEvent, revision: number) => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const emit = (e: StoreEvent) => {
  revision++;
  for (const l of [...listeners]) l(e, revision);
};

// ---- grants ---------------------------------------------------------------------------------------------------------

const linkOf = (g: GrantRow): PairingLink => ({
  id: g.id,
  subject: g.subject,
  ...(g.label ? { label: g.label } : {}),
  scopes: g.scopes,
  createdAt: iso(g.createdAt),
  expiresAt: iso(g.expiresAt),
});

export function createGrant(o: { kind: "pairing" | "connect"; subject: string; scopes: readonly Scope[]; label?: string; jkt?: string; deviceType?: DeviceType; ttlMs?: number; now?: number }): { link: PairingLink; credential: string } {
  const now = o.now ?? Date.now();
  const credential = newCredential();
  const row: GrantRow = {
    id: `pl_${randomUUID()}`,
    hash: sha(credential),
    kind: o.kind,
    subject: o.subject,
    ...(o.label ? { label: o.label } : {}),
    scopes: [...o.scopes],
    ...(o.jkt ? { jkt: o.jkt } : {}),
    deviceType: o.deviceType ?? "unknown",
    createdAt: now,
    expiresAt: now + (o.ttlMs ?? (o.kind === "connect" ? CONNECT_TTL_MS : PAIRING_TTL_MS)),
  };
  change((s) => s.grants.push(row));
  // connect grants are the connect service's, made and spent within seconds: the access list shows pairing links only
  if (o.kind === "pairing") emit({ type: "pairingLinkUpserted", link: linkOf(row) });
  return { link: linkOf(row), credential };
}

export type RedeemResult = { ok: true; grant: Omit<GrantRow, "hash">; scopes: Scope[] } | { ok: false; error: "invalid_grant" | "invalid_scope" };

/**
 * Spend a code. Answered without spending it: a proof by the wrong key (or none for a connect code), and requested
 * scopes with nothing in common with the grant. An expired code is dropped. Otherwise it is gone, whatever comes next.
 */
export function redeemGrant(credential: string, o: { jkt?: string; requested?: Scope[]; now?: number }): RedeemResult {
  const now = o.now ?? Date.now();
  const c = normalizeCredential(credential);
  if (!c) return { ok: false, error: "invalid_grant" };
  const hash = sha(c);
  // a code the file doesn't hold (load() reads another server's write) is answered without the lock or a write
  if (!load().grants.some((g) => g.hash === hash)) return { ok: false, error: "invalid_grant" };
  // looked at and spent under one lock: two servers on one file never both spend a code
  const { result, gone } = change((s): { result: RedeemResult; gone?: GrantRow } => {
    const i = s.grants.findIndex((g) => g.hash === hash);
    if (i < 0) return { result: { ok: false, error: "invalid_grant" } };
    const g = s.grants[i];
    if (g.expiresAt <= now) {
      s.grants.splice(i, 1);
      return { result: { ok: false, error: "invalid_grant" }, gone: g };
    }
    if (g.jkt && g.jkt !== o.jkt) return { result: { ok: false, error: "invalid_grant" } };
    const scopes = o.requested ? g.scopes.filter((x) => o.requested!.includes(x)) : g.scopes;
    if (scopes.length === 0) return { result: { ok: false, error: "invalid_scope" } };
    s.grants.splice(i, 1);
    const { hash: _h, ...grant } = g;
    return { result: { ok: true, grant, scopes }, gone: g };
  }, (o) => o.gone !== undefined);
  if (gone?.kind === "pairing") emit({ type: "pairingLinkRemoved", id: gone.id, subject: gone.subject });
  return result;
}

export function revokeLink(id: string, may: (subject: string) => boolean): boolean {
  const g = change((s) => {
    const i = s.grants.findIndex((x) => x.id === id && x.kind === "pairing" && may(x.subject));
    return i < 0 ? null : s.grants.splice(i, 1)[0];
  });
  if (!g) return false;
  emit({ type: "pairingLinkRemoved", id: g.id, subject: g.subject });
  return true;
}

// ---- sessions -------------------------------------------------------------------------------------------------------

export function issueSession(o: { subject: string; scopes: Scope[]; jkt?: string; client: ClientMetadata; now?: number }): { token: string; row: SessionRow } {
  const now = o.now ?? Date.now();
  const token = `cts_${randomBytes(32).toString("base64url")}`;
  const row: SessionRow = {
    id: `cs_${randomUUID()}`,
    hash: sha(token),
    subject: o.subject,
    scopes: o.scopes,
    method: o.jkt ? "dpop-access-token" : "bearer-access-token",
    ...(o.jkt ? { jkt: o.jkt } : {}),
    client: o.client,
    issuedAt: now,
    expiresAt: now + (o.jkt ? DPOP_TTL_MS : BEARER_TTL_MS),
    lastConnectedAt: null,
    revokedAt: null,
  };
  change((s) => s.sessions.push(row));
  emit({ type: "clientUpserted", row });
  return { token, row };
}

/** A session by its id (the request's, set by the account gate in boot.ts). */
export const sessionById = (id: string): SessionRow | undefined => load().sessions.find((r) => r.id === id);

export type ResolveResult = { ok: true; row: SessionRow } | { ok: false; code: "INVALID_TOKEN" | "SESSION_EXPIRED" | "SESSION_REVOKED" };

export function resolveToken(token: string, now = Date.now()): ResolveResult {
  if (!TOKEN_RE.test(token)) return { ok: false, code: "INVALID_TOKEN" };
  const hash = sha(token);
  const row = sessionByHash(hash);
  if (!row) return { ok: false, code: "INVALID_TOKEN" };
  if (row.revokedAt) return { ok: false, code: "SESSION_REVOKED" };
  if (row.expiresAt <= now) return { ok: false, code: "SESSION_EXPIRED" };
  return { ok: true, row };
}

/** A request on this session: lastConnectedAt, at most once a minute, kept in memory and written with the others. */
export function touchSession(row: SessionRow, now = Date.now()): void {
  if (row.lastConnectedAt !== null && now - row.lastConnectedAt < TOUCH_EVERY_MS) return;
  row.lastConnectedAt = now;
  touched.set(row.id, now);
  emit({ type: "clientUpserted", row });
}

/** Every session's lastConnectedAt seen since the last flush, in one write. Once a minute, and at exit. */
export function flushTouches(): void {
  if (touched.size === 0) return;
  const batch = new Map(touched);
  try {
    change((s) => {
      for (const r of s.sessions) {
        const at = batch.get(r.id);
        if (at !== undefined && (r.lastConnectedAt ?? 0) < at) r.lastConnectedAt = at;
      }
    });
    for (const [id, at] of batch) if (touched.get(id) === at) touched.delete(id);
  } catch (e) {
    console.error("clients.json: lastConnectedAt not written yet", (e as Error).message); // kept for the next flush
  }
}
setInterval(flushTouches, TOUCH_EVERY_MS).unref();
process.once("exit", flushTouches); // synchronous: every process.exit (a pm2 reload, a container stop) writes what is left

// open change streams per session: `connected`, and how a revoke ends them at once
const lines = new Map<string, Set<() => void>>();

/** A change stream of this session opened. `end` closes it; the returned function is for when it closed itself. */
export function holdLine(sessionId: string, end: () => void): () => void {
  let set = lines.get(sessionId);
  if (!set) lines.set(sessionId, (set = new Set()));
  set.add(end);
  const row = load().sessions.find((r) => r.id === sessionId);
  if (row && set.size === 1) emit({ type: "clientUpserted", row });
  return () => {
    const s = lines.get(sessionId);
    if (!s?.delete(end)) return;
    if (s.size === 0) {
      lines.delete(sessionId);
      const r = load().sessions.find((x) => x.id === sessionId);
      if (r && !r.revokedAt) emit({ type: "clientUpserted", row: r });
    }
  };
}

export const isConnected = (sessionId: string) => (lines.get(sessionId)?.size ?? 0) > 0;

/** Marks every matching live session revoked (one write), then ends their open lines. */
function revokeWhere(match: (r: SessionRow) => boolean, now: number, alsoGrants?: (g: GrantRow) => boolean): number {
  const { hit, links } = change((s) => {
    const hit = s.sessions.filter((r) => !r.revokedAt && match(r));
    for (const r of hit) r.revokedAt = now;
    const links = alsoGrants ? s.grants.filter(alsoGrants) : [];
    if (alsoGrants) s.grants = s.grants.filter((g) => !alsoGrants(g));
    return { hit, links };
  });
  for (const r of hit) {
    for (const end of [...(lines.get(r.id) ?? [])]) end();
    lines.delete(r.id);
    emit({ type: "clientRemoved", sessionId: r.id, subject: r.subject });
  }
  for (const g of links) if (g.kind === "pairing") emit({ type: "pairingLinkRemoved", id: g.id, subject: g.subject });
  return hit.length;
}

export const revokeSession = (id: string, may: (subject: string) => boolean, now = Date.now()): boolean =>
  revokeWhere((r) => r.id === id && may(r.subject), now) > 0;

/** Every live session the caller may see, but `keep`. */
export const revokeOthers = (keep: string | undefined, may: (subject: string) => boolean, now = Date.now()): number =>
  revokeWhere((r) => r.id !== keep && may(r.subject), now);

/**
 * An account's password changed, it signed out everywhere or it was deleted (users.ts): every device of it is signed
 * out and its unused links and codes go, as its browsers' cookies stop working.
 */
export const revokeAccount = (subject: string, now = Date.now()): number =>
  revokeWhere((r) => r.subject === subject, now, (g) => g.subject === subject);

// ---- listing --------------------------------------------------------------------------------------------------------

export const sessionView = (r: SessionRow, currentId?: string): ClientSession => ({
  sessionId: r.id,
  subject: r.subject,
  ...(r.client.label ? { label: r.client.label } : {}),
  scopes: r.scopes,
  method: r.method,
  client: r.client,
  issuedAt: iso(r.issuedAt),
  expiresAt: iso(r.expiresAt),
  lastConnectedAt: r.lastConnectedAt === null ? null : iso(r.lastConnectedAt),
  connected: isConnected(r.id),
  current: r.id === currentId,
});

/** Sessions with an open line stay listed after they expire; revoked ones never are. */
export const listedSession = (r: SessionRow, now = Date.now()) => !r.revokedAt && (r.expiresAt > now || isConnected(r.id));

export function accessSnapshot(may: (subject: string) => boolean, currentId?: string, now = Date.now()): AccessSnapshot {
  const s = load();
  return {
    pairingLinks: s.grants.filter((g) => g.kind === "pairing" && g.expiresAt > now && may(g.subject)).map(linkOf),
    clientSessions: s.sessions.filter((r) => listedSession(r, now) && may(r.subject)).map((r) => sessionView(r, currentId)),
  };
}
