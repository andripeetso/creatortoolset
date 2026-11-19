import { Hono, type Context } from "hono";
import { randomUUID } from "node:crypto";
import { descriptor } from "../descriptor";
import { createGrant, STANDARD, type HealthAnswer, type MintAnswer } from "../lib/clients";
import { computerKey, parseRelayKey, signJws, verifyJws } from "./keys";
import { connectState, consumeJti, type ConnectState } from "./state";

/**
 * The connect service asks this computer, through its tunnel, two things: is it up (health), and a one-time code for
 * a phone the account vouches for (mint). Each request is a short JWS by the broker key pinned at link time, its jti
 * and nonce used once; each answer is signed by this computer's own key over the request's nonce, so the service can
 * tell the real computer answered. Mounted before the account gate: the proof is the only credential.
 */
export const MAX_PROOF_LIFETIME_S = 300;
export const CLOCK_SKEW_S = 60;
export const HEALTH_ANSWER_S = 60;

export const audienceOf = (serverId: string) => `ct-computer:${serverId}`;
const issuerOf = (brokerUrl: string) => new URL(brokerUrl).origin;

type Checked = { ok: true; p: Record<string, unknown>; s: ConnectState } | { ok: false; status: 401 | 404 | 409 | 421; error: string };

/** Every check the two routes share; `extra` adds the mint's own. jti and nonce are burned only when all pass. */
export function checkRequest(c: Context, proof: unknown, o: { typ: string; scope: string; now: number; extra?: (p: Record<string, unknown>) => boolean }): Checked {
  const s = connectState();
  if (!s) return { ok: false, status: 404, error: "not_linked" };
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host !== s.hostname.toLowerCase() || c.req.header("x-forwarded-host") !== undefined) return { ok: false, status: 421, error: "wrong_host" };
  let key;
  try {
    key = parseRelayKey(s.relayPublicKey);
  } catch {
    return { ok: false, status: 401, error: "proof_rejected" };
  }
  const p = typeof proof === "string" ? verifyJws(proof, o.typ, key) : null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : NaN);
  const str = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
  const iat = n(p?.iat);
  const exp = n(p?.exp);
  if (
    !p ||
    p.iss !== issuerOf(s.brokerUrl) ||
    p.aud !== audienceOf(computerKey().id) ||
    p.sub !== s.owner ||
    !str(p.jti) ||
    !str(p.nonce) ||
    !(exp > iat) ||
    exp - iat > MAX_PROOF_LIFETIME_S ||
    iat > o.now + CLOCK_SKEW_S ||
    exp <= o.now ||
    !Array.isArray(p.scope) ||
    p.scope.length !== 1 ||
    p.scope[0] !== o.scope ||
    (o.extra && !o.extra(p))
  ) {
    return { ok: false, status: 401, error: "proof_rejected" };
  }
  // both burned for the proof's life: a second use of either is a replay, even under a new jti
  const jtiFresh = consumeJti(`jti:${p.jti as string}`, exp, o.now);
  const nonceFresh = consumeJti(`nonce:${p.nonce as string}`, exp, o.now);
  if (!jtiFresh || !nonceFresh) return { ok: false, status: 409, error: "proof_replayed" };
  return { ok: true, p, s: connectState()! };
}

export const connectPublicApp = new Hono();

const proofOf = async (c: Context) => ((await c.req.json().catch(() => null)) as { proof?: unknown } | null)?.proof;

connectPublicApp.post("/health", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const r = checkRequest(c, await proofOf(c), { typ: "ct-connect-health+jwt", scope: "status", now });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  const id = computerKey().id;
  const checkedAt = new Date(now * 1000).toISOString();
  const d = descriptor();
  const proof = signJws("ct-connect-health-answer+jwt", {
    iss: audienceOf(id),
    aud: issuerOf(r.s.brokerUrl),
    sub: id,
    jti: randomUUID(),
    iat: now,
    exp: now + HEALTH_ANSWER_S,
    requestNonce: r.p.nonce,
    status: "online",
    checkedAt,
    descriptor: d,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ serverId: id, status: "online", checkedAt, descriptor: d, proof } satisfies HealthAnswer);
});

connectPublicApp.post("/mint", async (c) => {
  const now = Math.floor(Date.now() / 1000);
  const r = checkRequest(c, await proofOf(c), {
    typ: "ct-connect-mint+jwt",
    scope: "connect",
    now,
    extra: (p) =>
      typeof p.clientProofKeyThumbprint === "string" &&
      /^[A-Za-z0-9_-]{43}$/.test(p.clientProofKeyThumbprint) &&
      (p.cnf as { jkt?: unknown } | undefined)?.jkt === p.clientProofKeyThumbprint,
  });
  if (!r.ok) return c.json({ error: r.error }, r.status);
  const jkt = r.p.clientProofKeyThumbprint as string;
  // the account's phone signs in as the local account that linked this computer, with Standard access
  const { link, credential } = createGrant({ kind: "connect", subject: r.s.localUser, scopes: STANDARD, jkt, deviceType: "mobile", label: "Through your account", now: now * 1000 });
  const id = computerKey().id;
  const exp = Math.floor(Date.parse(link.expiresAt) / 1000);
  const proof = signJws("ct-connect-mint-answer+jwt", {
    iss: audienceOf(id),
    aud: issuerOf(r.s.brokerUrl),
    sub: id,
    jti: randomUUID(),
    iat: now,
    exp,
    requestNonce: r.p.nonce,
    clientProofKeyThumbprint: jkt,
    credential,
  });
  c.header("Cache-Control", "no-store");
  return c.json({ credential, expiresAt: link.expiresAt, proof } satisfies MintAnswer);
});
