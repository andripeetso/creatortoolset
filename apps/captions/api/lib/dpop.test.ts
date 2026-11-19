import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dpopVectors } from "../../../relay/test/dpop-vectors";
import { MAX_JTIS_PER_KEY, dpopReplayForTest, htuOf, jwkThumbprint, resetDpopReplay, spendJti, tokenHash, verifyDpop } from "./dpop";

// a data folder of this file's own: spent proofs are kept on disk there too
const DATA = await vi.hoisted(async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return (process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "dpop-jti-")));
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const keyPair = () => {
  const k = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const j = k.publicKey.export({ format: "jwk" }) as { kty: "EC"; crv: "P-256"; x: string; y: string };
  return { privateKey: k.privateKey, jwk: { kty: j.kty, crv: j.crv, x: j.x, y: j.y } };
};
function proofBy(key: { privateKey: KeyObject; jwk: object }, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64({ typ: "dpop+jwt", alg: "ES256", jwk: key.jwk, ...header });
  const p = b64({ iat: Math.floor(Date.now() / 1000), jti: randomUUID(), ...claims });
  return `${h}.${p}.${sign("sha256", Buffer.from(`${h}.${p}`), { key: key.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
}

const phone = keyPair();
const URL_ = "https://abc.tunnels.example/oauth/token";

beforeEach(() => resetDpopReplay());

describe("DPoP proofs", () => {
  it("accepts a proof for this method and URL and names its key's RFC 7638 thumbprint", () => {
    const r = verifyDpop({ proof: proofBy(phone, { htm: "POST", htu: URL_ }), method: "POST", url: `${URL_}?x=1` });
    expect(r).toEqual({ ok: true, jkt: jwkThumbprint(phone.jwk as never), jti: expect.any(String) });
    // RFC 7638: SHA-256 over the required members in lexical order, no spaces, so the phone and the relay agree
    const j = phone.jwk as { x: string; y: string };
    expect(jwkThumbprint(phone.jwk as never)).toBe(createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${j.x}","y":"${j.y}"}`).digest("base64url"));
  });

  it("refuses the wrong method, URL, key, token hash, type and a missing proof", () => {
    expect(verifyDpop({ proof: proofBy(phone, { htm: "GET", htu: URL_ }), method: "POST", url: URL_ })).toEqual({ ok: false, code: "method_mismatch" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "POST", htu: "https://other.example/oauth/token" }), method: "POST", url: URL_ })).toEqual({ ok: false, code: "url_mismatch" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "POST", htu: URL_ }), method: "POST", url: URL_, expectedJkt: jwkThumbprint(keyPair().jwk as never) })).toEqual({ ok: false, code: "key_mismatch" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "GET", htu: URL_, ath: tokenHash("cts_a") }), method: "GET", url: URL_, accessToken: "cts_b" })).toEqual({ ok: false, code: "token_mismatch" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "GET", htu: URL_ }), method: "GET", url: URL_, accessToken: "cts_b" })).toEqual({ ok: false, code: "token_mismatch" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "POST", htu: URL_ }, { typ: "JWT" }), method: "POST", url: URL_ })).toEqual({ ok: false, code: "malformed" });
    expect(verifyDpop({ proof: proofBy(phone, { htm: "POST", htu: URL_ }, { alg: "ES384" }), method: "POST", url: URL_ })).toEqual({ ok: false, code: "malformed" });
    expect(verifyDpop({ proof: undefined, method: "POST", url: URL_ })).toEqual({ ok: false, code: "missing" });
    expect(verifyDpop({ proof: "a.b", method: "POST", url: URL_ })).toEqual({ ok: false, code: "malformed" });
  });

  it("refuses a proof signed by another key than the one in its header", () => {
    const other = keyPair();
    const forged = proofBy({ privateKey: other.privateKey, jwk: phone.jwk }, { htm: "POST", htu: URL_ });
    expect(verifyDpop({ proof: forged, method: "POST", url: URL_ })).toEqual({ ok: false, code: "signature" });
  });

  it("keeps iat within ±300 s", () => {
    const now = Date.now();
    const at = (s: number) => proofBy(phone, { htm: "POST", htu: URL_, iat: Math.floor(now / 1000) + s });
    expect(verifyDpop({ proof: at(-299), method: "POST", url: URL_, now }).ok).toBe(true);
    expect(verifyDpop({ proof: at(299), method: "POST", url: URL_, now }).ok).toBe(true);
    expect(verifyDpop({ proof: at(-301), method: "POST", url: URL_, now })).toEqual({ ok: false, code: "time_window" });
    expect(verifyDpop({ proof: at(301), method: "POST", url: URL_, now })).toEqual({ ok: false, code: "time_window" });
  });

  it("accepts each jti once", () => {
    const p = proofBy(phone, { htm: "POST", htu: URL_ });
    expect(verifyDpop({ proof: p, method: "POST", url: URL_ }).ok).toBe(true);
    expect(verifyDpop({ proof: p, method: "POST", url: URL_ })).toEqual({ ok: false, code: "replay" });
  });

  it("names the URL without query or fragment", () => {
    expect(htuOf("https://h.example:8443/a/b?c=1#d")).toBe("https://h.example:8443/a/b");
    expect(htuOf("not a url")).toBeNull();
  });
});

describe("the shared vectors (the connect service runs the same ones)", () => {
  it("answers each the way the shared check does", () => {
    for (const v of dpopVectors()) {
      const r = verifyDpop({ proof: v.proof, method: v.method, url: v.url, now: v.nowS * 1000, accessToken: v.accessToken, expectedJkt: v.jkt });
      expect({ name: v.name, code: r.ok ? "ok" : r.code }).toEqual({ name: v.name, code: v.expect });
    }
  });
});

describe("the proof-id cache", () => {
  it("refuses a key holding its cap of live ids, never forgetting one, lets every other key on, and takes it again once they expire", () => {
    const seen = dpopReplayForTest();
    const now = Date.now();
    const mine = jwkThumbprint(phone.jwk as never);
    seen.set(mine, new Map(Array.from({ length: MAX_JTIS_PER_KEY }, (_, i) => [`flood${i}`, now / 1000 + 600])));
    const p = proofBy(phone, { htm: "POST", htu: URL_ });
    expect(verifyDpop({ proof: p, method: "POST", url: URL_, now })).toEqual({ ok: false, code: "busy" });
    expect(seen.get(mine)!.size).toBe(MAX_JTIS_PER_KEY);
    // one key's flood is that key's alone
    expect(verifyDpop({ proof: proofBy(keyPair(), { htm: "POST", htu: URL_ }), method: "POST", url: URL_, now })).toMatchObject({ ok: true });
    // ten minutes on, the flood's ids could no longer pass: they go, and a fresh proof is taken
    const later = now + 600_001;
    const q = proofBy(phone, { htm: "POST", htu: URL_, iat: Math.floor(later / 1000) });
    expect(verifyDpop({ proof: q, method: "POST", url: URL_, now: later })).toMatchObject({ ok: true });
    expect(seen.get(mine)!.size).toBe(1);
  });

  it("checks without spending when asked, and spends once", () => {
    const p = proofBy(phone, { htm: "POST", htu: URL_ });
    const v = verifyDpop({ proof: p, method: "POST", url: URL_, spend: false });
    expect(v.ok).toBe(true);
    expect(verifyDpop({ proof: p, method: "POST", url: URL_, spend: false }).ok).toBe(true);
    if (!v.ok) return;
    expect(spendJti(v.jkt, v.jti)).toBe("ok");
    expect(spendJti(v.jkt, v.jti)).toBe("replay");
    expect(verifyDpop({ proof: p, method: "POST", url: URL_ })).toEqual({ ok: false, code: "replay" });
  });

  it("refuses a proof spent before a restart, or by the other process of a no-downtime swap", async () => {
    const p = proofBy(phone, { htm: "POST", htu: URL_ });
    expect(verifyDpop({ proof: p, method: "POST", url: URL_ }).ok).toBe(true);
    dpopReplayForTest().clear(); // a restart: what was in memory is gone
    expect(verifyDpop({ proof: p, method: "POST", url: URL_ })).toEqual({ ok: false, code: "replay" });
    // the other process spent this one: its row is in the same file
    const { DatabaseSync } = await import("node:sqlite");
    const other = new DatabaseSync(`${DATA}/dpop-jti.db`);
    other.prepare("INSERT INTO spent (jkt, jti, until) VALUES (?, ?, ?)").run(jwkThumbprint(phone.jwk as never), "spent-elsewhere", Date.now() / 1000 + 600);
    other.close();
    const q = proofBy(phone, { htm: "POST", htu: URL_, jti: "spent-elsewhere" });
    expect(verifyDpop({ proof: q, method: "POST", url: URL_ })).toEqual({ ok: false, code: "replay" });
  });

  it("tries the file again a minute after it failed to open, with one log line per try", async () => {
    const { existsSync, rmSync, writeFileSync } = await import("node:fs");
    const blocker = `${DATA}-blocker`;
    writeFileSync(blocker, ""); // a file where the data folder's parent should be: it can't be made
    process.env.DATA_DIR = `${blocker}/data`;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      vi.resetModules();
      const d = await import("./dpop");
      const t = Date.now();
      expect(d.spendJti("k", "a", t)).toBe("ok"); // in memory only
      expect(d.spendJti("k", "b", t + 30_000)).toBe("ok");
      expect(errors).toHaveBeenCalledTimes(1); // not tried again within the minute
      expect(d.spendJti("k", "c", t + 61_000)).toBe("ok");
      expect(errors).toHaveBeenCalledTimes(2); // tried again, still failing: one more line
      rmSync(blocker);
      expect(d.spendJti("k", "d", t + 122_000)).toBe("ok");
      expect(existsSync(`${blocker}/data/dpop-jti.db`)).toBe(true);
      expect(errors).toHaveBeenCalledTimes(2);
    } finally {
      errors.mockRestore();
      process.env.DATA_DIR = DATA;
    }
  });

  it("forgets expired ids on a timer that never keeps the process alive", async () => {
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const d = await import("./dpop");
      const s = Date.now() / 1000;
      d.dpopReplayForTest().set("k", new Map([["old", s + 1], ["live", s + 600]]));
      d.dpopReplayForTest().set("gone", new Map([["old", s + 1]]));
      vi.advanceTimersByTime(61_000);
      expect([...d.dpopReplayForTest().keys()]).toEqual(["k"]);
      expect([...d.dpopReplayForTest().get("k")!.keys()]).toEqual(["live"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
