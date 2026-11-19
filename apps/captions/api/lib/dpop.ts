import { checkProof, JTI_KEEP_S, MAX_JTIS_PER_KEY, type DpopFailure, type JtiSpend } from "../../../relay/src/dpop-proof";

/**
 * DPoP proofs (RFC 9449), ES256 only. The check is the one the connect service runs too (apps/relay/src/dpop-proof.ts,
 * imported as source: the bundle carries it, and the relay runs it without a build). Spent `jti`s are kept here in
 * memory, per key, for 10 min (longer than any `iat` they could pass with).
 */
export { DPOP_SKEW_S, MAX_JTIS_PER_KEY, htuOf, jwkThumbprint, tokenHash, type DpopFailure } from "../../../relay/src/dpop-proof";
export type DpopResult = { ok: true; jkt: string; jti: string } | { ok: false; code: DpopFailure };

const seen = new Map<string, Map<string, number>>(); // jkt -> jti -> forget after (s)

const pruneKey = (jkt: string, ids: Map<string, number>, nowS: number) => {
  for (const [jti, until] of ids) if (until <= nowS) ids.delete(jti);
  if (ids.size === 0) seen.delete(jkt);
};
const prune = (nowS = Date.now() / 1000) => {
  for (const [jkt, ids] of seen) pruneKey(jkt, ids, nowS);
};
setInterval(prune, 60_000).unref();

/** One key past its cap is busy; every other key goes on. Only a session's own key or a redeemed code reaches here. */
const spend: JtiSpend = (jkt, jti, untilS, nowS) => {
  let ids = seen.get(jkt);
  if (!ids) seen.set(jkt, (ids = new Map()));
  if (ids.has(jti)) return "replay";
  if (ids.size >= MAX_JTIS_PER_KEY) pruneKey(jkt, ids, nowS);
  if (ids.size >= MAX_JTIS_PER_KEY) return "busy";
  ids.set(jti, untilS);
  if (!seen.has(jkt)) seen.set(jkt, ids);
  return "ok";
};

/** Spends a proof checked with `spend: false`, once what it came with went through (POST /oauth/token: the code). */
export const spendJti = (jkt: string, jti: string, now = Date.now()): "ok" | "replay" | "busy" => spend(jkt, jti, now / 1000 + JTI_KEEP_S, now / 1000);

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
  /** false: the jti is checked, not spent; the caller spends it with spendJti */
  spend?: boolean;
}): DpopResult {
  const nowS = (o.now ?? Date.now()) / 1000;
  return checkProof(
    { proof: o.proof, method: o.method, url: o.url, nowS, accessToken: o.accessToken, jkt: o.expectedJkt },
    o.spend === false ? undefined : spend,
  );
}
