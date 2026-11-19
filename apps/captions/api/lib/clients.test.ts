import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATA_DIR = mkdtempSync(path.join(process.env.CT_SCRATCH_DIR ?? tmpdir(), "clients-"));
const c = await import("./clients");

beforeEach(() => c.resetClientsForTest());
const all = () => true;

describe("pairing credentials", () => {
  it("are 12 characters of the unambiguous alphabet, spread over all of it", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = c.newCredential();
      expect(code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/);
      for (const ch of code) seen.add(ch);
    }
    expect(seen.size).toBe(32);
  });

  it("are read case-insensitively, with spaces and dashes dropped", () => {
    expect(c.normalizeCredential("abcd-efgh 2345")).toBe("ABCDEFGH2345");
    expect(c.normalizeCredential("ABCDEFGH234O")).toBeNull(); // O is not in the alphabet
    expect(c.normalizeCredential("short")).toBeNull();
  });

  it("work once, within 5 minutes, and the file never holds the code", () => {
    const now = Date.now();
    const a = c.createGrant({ kind: "pairing", subject: "admin", scopes: c.STANDARD, label: "iPad", now });
    expect(Date.parse(a.link.expiresAt) - now).toBe(5 * 60_000);
    expect(readFileSync(path.join(process.env.DATA_DIR!, "clients.json"), "utf8")).not.toContain(a.credential);
    const r = c.redeemGrant(a.credential.toLowerCase(), { now: now + 1000 });
    expect(r).toMatchObject({ ok: true, scopes: ["read", "write", "access"], grant: { subject: "admin", label: "iPad" } });
    expect(c.redeemGrant(a.credential, { now: now + 2000 })).toEqual({ ok: false, error: "invalid_grant" });

    const b = c.createGrant({ kind: "pairing", subject: "admin", scopes: c.STANDARD, now });
    expect(c.redeemGrant(b.credential, { now: now + 5 * 60_000 })).toEqual({ ok: false, error: "invalid_grant" });
    expect(c.accessSnapshot(all).pairingLinks.map((l) => l.id)).not.toContain(b.link.id);
  });

  it("intersect the requested scopes and refuse an empty result before spending the code", () => {
    const g = c.createGrant({ kind: "pairing", subject: "admin", scopes: c.READ_ONLY });
    expect(c.redeemGrant(g.credential, { requested: ["write"] })).toEqual({ ok: false, error: "invalid_scope" });
    expect(c.redeemGrant(g.credential, { requested: ["read", "write"] })).toMatchObject({ ok: true, scopes: ["read"] });
  });

  it("bound to a key are not spent by a redeem without that key", () => {
    const g = c.createGrant({ kind: "connect", subject: "admin", scopes: c.STANDARD, jkt: "k".repeat(43) });
    expect(c.redeemGrant(g.credential, {})).toEqual({ ok: false, error: "invalid_grant" });
    expect(c.redeemGrant(g.credential, { jkt: "x".repeat(43) })).toEqual({ ok: false, error: "invalid_grant" });
    expect(c.redeemGrant(g.credential, { jkt: "k".repeat(43) })).toMatchObject({ ok: true });
    // connect codes never show among the pairing links
    expect(c.accessSnapshot(all).pairingLinks.some((l) => l.id === g.link.id)).toBe(false);
  });
});

describe("client sessions", () => {
  it("Bearer lasts 30 days and DPoP 1 hour, never extended by use", () => {
    const now = Date.now();
    const b = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" }, now });
    expect(b.row.expiresAt - now).toBe(30 * 24 * 3600_000);
    expect(b.token).toMatch(c.TOKEN_RE);
    const d = c.issueSession({ subject: "admin", scopes: ["read"], jkt: "j".repeat(43), client: { deviceType: "mobile" }, now });
    expect(d.row.expiresAt - now).toBe(3600_000);
    expect(d.row.method).toBe("dpop-access-token");
    c.touchSession(b.row, now + 10 * 60_000);
    expect(b.row.expiresAt - now).toBe(30 * 24 * 3600_000);
    expect(c.resolveToken(b.token, now + 30 * 24 * 3600_000)).toEqual({ ok: false, code: "SESSION_EXPIRED" });
    expect(c.resolveToken("cts_" + "A".repeat(43))).toEqual({ ok: false, code: "INVALID_TOKEN" });
  });

  it("write lastConnectedAt at most once a minute", () => {
    const now = Date.now();
    const s = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" }, now });
    c.touchSession(s.row, now);
    c.touchSession(s.row, now + 30_000);
    expect(s.row.lastConnectedAt).toBe(now);
    c.touchSession(s.row, now + 61_000);
    expect(s.row.lastConnectedAt).toBe(now + 61_000);
  });

  it("a revoke marks the row, ends its open lines at once and drops it from the list", () => {
    const s = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" } });
    let ended = 0;
    c.holdLine(s.row.id, () => ended++);
    expect(c.accessSnapshot(all).clientSessions.find((x) => x.sessionId === s.row.id)?.connected).toBe(true);
    expect(c.revokeSession(s.row.id, all)).toBe(true);
    expect(ended).toBe(1);
    expect(c.resolveToken(s.token)).toEqual({ ok: false, code: "SESSION_REVOKED" });
    expect(c.accessSnapshot(all).clientSessions.some((x) => x.sessionId === s.row.id)).toBe(false);
  });

  it("stay listed past expiry while a line is open; listings never carry a token or a hash", () => {
    const s = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" }, jkt: "j".repeat(43) });
    const later = Date.now() + 2 * 3600_000; // past its hour
    expect(c.accessSnapshot(all, undefined, later).clientSessions.some((x) => x.sessionId === s.row.id)).toBe(false);
    const release = c.holdLine(s.row.id, () => {});
    const listed = c.accessSnapshot(all, s.row.id, later);
    expect(listed.clientSessions.find((x) => x.sessionId === s.row.id)).toMatchObject({ connected: true, current: true });
    expect(JSON.stringify(listed)).not.toContain(s.token);
    expect(JSON.stringify(listed)).not.toContain(s.row.hash);
    release();
  });

  it("revoke-others keeps the caller's own and only touches what it may", () => {
    const mine = c.issueSession({ subject: "sam", scopes: ["read"], client: { deviceType: "mobile" } });
    const other = c.issueSession({ subject: "sam", scopes: ["read"], client: { deviceType: "tablet" } });
    const someoneElse = c.issueSession({ subject: "kim", scopes: ["read"], client: { deviceType: "mobile" } });
    expect(c.revokeOthers(mine.row.id, (s) => s === "sam")).toBe(1);
    expect(c.resolveToken(mine.token).ok).toBe(true);
    expect(c.resolveToken(other.token)).toEqual({ ok: false, code: "SESSION_REVOKED" });
    expect(c.resolveToken(someoneElse.token).ok).toBe(true);
  });

  it("announce every change with a rising revision", () => {
    const got: string[] = [];
    const off = c.onAccessChange((e, rev) => got.push(`${rev > 0}:${e.type}`));
    const g = c.createGrant({ kind: "pairing", subject: "admin", scopes: c.STANDARD });
    c.redeemGrant(g.credential, {});
    c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" } });
    off();
    expect(got).toEqual(["true:pairingLinkUpserted", "true:pairingLinkRemoved", "true:clientUpserted"]);
  });
});

describe("two servers on one file (the no-downtime swap)", () => {
  it("see each other's revokes and issues, and spend a code once", async () => {
    vi.resetModules();
    const b = await import("./clients"); // a second store, as the other process holds it
    const one = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" } });
    expect(b.resolveToken(one.token).ok).toBe(true);
    c.revokeSession(one.row.id, all);
    expect(b.resolveToken(one.token)).toEqual({ ok: false, code: "SESSION_REVOKED" });
    // a later write by B keeps A's revoke
    b.createGrant({ kind: "pairing", subject: "admin", scopes: ["read"] });
    expect(c.resolveToken(one.token)).toEqual({ ok: false, code: "SESSION_REVOKED" });
    // one code, redeemed by both: it works once
    const { credential } = b.createGrant({ kind: "pairing", subject: "admin", scopes: ["read"] });
    c.resolveToken(one.token); // A has read the file with the code in it
    const results = [c.redeemGrant(credential, {}), b.redeemGrant(credential, {})];
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    // a session issued by B is kept through a write by A
    const two = b.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" } });
    c.createGrant({ kind: "pairing", subject: "admin", scopes: ["read"] });
    expect(b.resolveToken(two.token).ok).toBe(true);
    expect(c.resolveToken(two.token).ok).toBe(true);
  });

  it("a lock left by a server that died is cleared; the file is never written without it", () => {
    const file = path.join(process.env.DATA_DIR!, "clients.json");
    const lock = `${file}.lock`;
    writeFileSync(lock, "");
    const old = (Date.now() - c.LOCK_STALE_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    c.createGrant({ kind: "pairing", subject: "admin", scopes: ["read"] });
    expect(existsSync(lock)).toBe(false);
    expect(JSON.parse(readFileSync(file, "utf8")).grants.length).toBeGreaterThan(0);
  });

  it("an account's password change, sign-out or deletion signs out all its devices and drops its codes", () => {
    const mine = c.issueSession({ subject: "tiny-only", scopes: ["read"], client: { deviceType: "mobile" } });
    const other = c.issueSession({ subject: "admin", scopes: ["read"], client: { deviceType: "mobile" } });
    const { credential } = c.createGrant({ kind: "pairing", subject: "tiny-only", scopes: ["read"] });
    let ended = 0;
    c.holdLine(mine.row.id, () => ended++);
    expect(c.revokeAccount("tiny-only")).toBe(1);
    expect(ended).toBe(1);
    expect(c.resolveToken(mine.token)).toEqual({ ok: false, code: "SESSION_REVOKED" });
    expect(c.resolveToken(other.token).ok).toBe(true);
    expect(c.redeemGrant(credential, {})).toEqual({ ok: false, error: "invalid_grant" });
  });
});
