import { createHash, generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { htuOf, jwkThumbprint, resetDpopReplay, tokenHash, verifyDpop } from "./dpop";

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
