import { createHash, createPublicKey, verify } from "node:crypto";

/**
 * DPoP proofs (RFC 9449), ES256 only: a phone signs each request with its own P-256 key, so a token caught on the way
 * is useless without that key. Checked: `typ` dpop+jwt, `alg` ES256, a public P-256 `jwk` in the header, `htm` = the
 * method, `htu` = the request URL without query or fragment, `iat` within ±300 s, `ath` when a token rides along, the
 * signature, and the `jti` once (kept 10 min, longer than any `iat` it could pass with).
 */
export const DPOP_SKEW_S = 300;
const REPLAY_MS = 2 * DPOP_SKEW_S * 1000;

export type DpopFailure = "missing" | "malformed" | "key_mismatch" | "method_mismatch" | "url_mismatch" | "token_mismatch" | "signature" | "time_window" | "replay" | "busy";
export type DpopResult = { ok: true; jkt: string; jti: string } | { ok: false; code: DpopFailure };

interface P256Jwk {
  kty: "EC";
  crv: "P-256";
  x: string;
  y: string;
}

const b64json = (s: string) => JSON.parse(Buffer.from(s, "base64url").toString()) as Record<string, unknown>;
const isB64 = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]+$/.test(v);

/** RFC 7638 thumbprint of a P-256 key: base64url(SHA-256 of {"crv","kty","x","y"} in that order). */
export const jwkThumbprint = (jwk: P256Jwk): string =>
  createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest("base64url");

/** `ath`: base64url(SHA-256(access token)). */
export const tokenHash = (token: string): string => createHash("sha256").update(token).digest("base64url");

/** The request URL as a proof names it: no query, no fragment. */
export function htuOf(url: string): string | null {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const seen = new Map<string, number>(); // jkt:jti -> forget after (ms)
/** Proof ids held at most: a flood of proofs (anyone may send one to /oauth/token) is refused, never let in by forgetting. */
export const MAX_JTIS = 50_000;

const prune = (now = Date.now()) => {
  for (const [k, until] of seen) if (until <= now) seen.delete(k);
};
setInterval(prune, 60_000).unref();

/** Forget every jti (tests). */
export const resetDpopReplay = () => seen.clear();
/** The jti map itself (tests fill it). */
export const dpopReplayForTest = () => seen;

export function verifyDpop(o: {
  proof: string | undefined;
  method: string;
  url: string;
  now?: number; // ms
  expectedJkt?: string;
  accessToken?: string;
}): DpopResult {
  const now = o.now ?? Date.now();
  if (!o.proof) return { ok: false, code: "missing" };
  const parts = o.proof.split(".");
  if (parts.length !== 3 || !parts.every(isB64)) return { ok: false, code: "malformed" };
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64json(parts[0]);
    payload = b64json(parts[1]);
  } catch {
    return { ok: false, code: "malformed" };
  }
  const jwk = header.jwk as Partial<P256Jwk> | undefined;
  if (
    header.typ !== "dpop+jwt" ||
    header.alg !== "ES256" ||
    !jwk ||
    jwk.kty !== "EC" ||
    jwk.crv !== "P-256" ||
    !isB64(jwk.x) ||
    !isB64(jwk.y) ||
    "d" in jwk ||
    typeof payload.htm !== "string" ||
    typeof payload.htu !== "string" ||
    typeof payload.jti !== "string" ||
    !payload.jti ||
    payload.jti.length > 256 ||
    typeof payload.iat !== "number"
  ) {
    return { ok: false, code: "malformed" };
  }
  const jkt = jwkThumbprint(jwk as P256Jwk);
  if (o.expectedJkt && jkt !== o.expectedJkt) return { ok: false, code: "key_mismatch" };
  if (payload.htm.toUpperCase() !== o.method.toUpperCase()) return { ok: false, code: "method_mismatch" };
  const htu = htuOf(o.url);
  if (!htu || payload.htu !== htu) return { ok: false, code: "url_mismatch" };
  if (o.accessToken !== undefined && payload.ath !== tokenHash(o.accessToken)) return { ok: false, code: "token_mismatch" };
  let signed = false;
  try {
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y }, format: "jwk" });
    signed = verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(parts[2], "base64url"));
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, code: "signature" };
  if (Math.abs(now / 1000 - payload.iat) > DPOP_SKEW_S) return { ok: false, code: "time_window" };
  const key = `${jkt}:${payload.jti}`;
  if (seen.has(key)) return { ok: false, code: "replay" };
  if (seen.size >= MAX_JTIS) prune(now);
  if (seen.size >= MAX_JTIS) return { ok: false, code: "busy" };
  seen.set(key, now + REPLAY_MS);
  return { ok: true, jkt, jti: payload.jti };
}
