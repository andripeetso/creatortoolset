import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { env } from "../lib/env";
import { dropAiKey, findUser, newAiKey, type SessionUser } from "../users";
import type { AuthVars } from "../auth";
import { BrokerError, accountOfToken, linkThisComputer, pollDeviceGrant, sendAiGrant, startDeviceGrant } from "./broker";
import { startConnector, stopConnector, unlinkConnector } from "./connector";
import { computerKey, keyId, parseRelayKey, publicKeyB64, signJws } from "./keys";
import { connectState, saveConnectState } from "./state";
import type { LinkProofAnswer, RelayConfigInput } from "../lib/clients";

// Settings → Connect: this server joins the account on the broker. Only the owner's signed-in admin may link it.
// The device code waits in memory (one pending link at a time): restarting the server cancels it, which is fine.
export const connectApp = new Hono<{ Variables: AuthVars }>();

let pending: { deviceCode: string; brokerUrl: string; localUser: string; expires: number } | null = null;

const brokerUrl = () => (env.connectUrl ?? "").trim();
const ownerOnly = (user: SessionUser | undefined) => !!user && user.role === "admin" && !!findUser(user.username);

connectApp.use(async (c, next) => {
  if (!ownerOnly(c.get("user"))) return c.json({ error: "Only the owner can connect this computer" }, 403);
  return next();
});

connectApp.get("/", (c) => {
  const s = connectState();
  return c.json({
    linked: !!s,
    name: s?.name ?? hostname(),
    hostname: s?.hostname ?? null,
    brokerConfigured: !!brokerUrl(),
    // the one address an AI app connects to, through the broker (sendAiGrant in broker.ts)
    ai: s ? new URL("/mcp", s.brokerUrl).href : null,
  });
});

connectApp.post("/start", async (c) => {
  const url = brokerUrl();
  if (!url) return c.json({ error: "This computer has no connect service set (CT_CONNECT_URL)" }, 400);
  if (connectState()) return c.json({ error: "This computer is already connected" }, 409);
  try {
    const g = await startDeviceGrant(url);
    pending = { deviceCode: g.device_code, brokerUrl: url, localUser: c.get("user").username, expires: Date.now() + g.expires_in * 1000 };
    return c.json({ user_code: g.user_code, verification_uri: g.verification_uri, verification_uri_complete: g.verification_uri_complete, expires_in: g.expires_in, interval: g.interval });
  } catch (e) {
    return c.json({ error: e instanceof BrokerError ? e.code : "broker_unreachable" }, 502);
  }
});

connectApp.post("/poll", async (c) => {
  if (!pending || pending.expires <= Date.now()) {
    pending = null;
    return c.json({ error: "No link is waiting: start again" }, 404);
  }
  const p = pending;
  let token: string;
  try {
    token = await pollDeviceGrant(p.brokerUrl, p.deviceCode);
  } catch (e) {
    if (e instanceof BrokerError && e.code === "authorization_pending") return c.json({ status: "pending" });
    pending = null;
    return c.json({ status: "failed", error: e instanceof BrokerError ? e.code : "broker_unreachable" });
  }
  pending = null;
  if (p.localUser !== c.get("user").username) return c.json({ error: "Start the link from the same account" }, 403);
  try {
    const s = await linkThisComputer({
      brokerUrl: p.brokerUrl,
      accessToken: token,
      owner: accountOfToken(token),
      localUser: p.localUser,
      name: hostname(),
      origin: `http://127.0.0.1:${process.env.PORT || "3000"}`,
    });
    startConnector(); // the tunnel runs from now on, not only after the next restart
    return c.json({ status: "linked", hostname: s.hostname });
  } catch (e) {
    return c.json({ status: "failed", error: e instanceof BrokerError ? e.code : "link_failed" });
  }
});

const AI_APPS = ["ChatGPT", "Claude"] as const;

// Install / Remove for ChatGPT and Claude on this computer. The broker is asked only on this press: the signed grant
// says which app and key the computer allows, and a removal sends null so the broker drops the app's connection too.
connectApp.post("/ai", async (c) => {
  const body = (await c.req.json().catch(() => null)) as { app?: unknown; on?: unknown } | null;
  const app = AI_APPS.find((a) => a === body?.app);
  if (!app || typeof body?.on !== "boolean") return c.json({ error: "Unknown AI app" }, 400);
  const s = connectState();
  if (!s) return c.json({ error: "This computer isn't linked to your account yet" }, 400);
  const user = findUser(c.get("user").username);
  if (!user) return c.json({ error: "Only the owner can connect this computer" }, 403);

  if (!body.on) {
    // removed here first: a broker that can't be reached must not keep the key working on this computer
    for (const k of (user.aiKeys ?? []).filter((k) => k.name === app && k.oauth)) dropAiKey(user, k.id);
    await sendAiGrant(s, app, null).catch(() => {});
    return c.json({ ok: true });
  }

  // the key is made here and the broker is told; if the broker refuses, this key is taken back, so none works unannounced
  const made = newAiKey(user, app, true);
  try {
    await sendAiGrant(s, app, made.key);
  } catch (e) {
    dropAiKey(user, made.id);
    if (e instanceof BrokerError && e.code === "unknown_computer") return c.json({ error: "This computer isn't linked to your account any more. Link it again." }, 502);
    if (e instanceof BrokerError && e.status === 404) return c.json({ error: "The Connect service doesn't take AI apps yet." }, 502);
    return c.json({ error: "The Connect service couldn't take it right now. Try again." }, 502);
  }
  return c.json({ ok: true });
});

// ---- Link with the Mac app's own account sign-in (contract.md): the Mac asks the connect service for a challenge,
// this computer signs it, the service links and answers, and the Mac hands that answer back here.

const loopbackOnly = (url: string, header: (h: string) => string | undefined) =>
  /^(127\.0\.0\.1|localhost|\[::1\])$/.test(new URL(url).hostname) && header("x-forwarded-host") === undefined && header("x-forwarded-proto") === undefined;
const localOrigin = () => `http://127.0.0.1:${process.env.PORT || "3000"}`;

connectApp.post("/link-proof", async (c) => {
  // the proof names this computer's loopback origin: only a request made on this computer may ask for it
  if (!loopbackOnly(c.req.url, (h) => c.req.header(h))) return c.json({ error: "Only from this computer" }, 403);
  const b = (await c.req.json().catch(() => null)) as { challenge?: unknown; relayUrl?: unknown } | null;
  const challenge = typeof b?.challenge === "string" && b.challenge.length > 0 && b.challenge.length <= 512 ? b.challenge : null;
  let aud: string | null = null;
  try {
    aud = typeof b?.relayUrl === "string" ? new URL(b.relayUrl).origin : null;
  } catch {
    aud = null;
  }
  if (!challenge || !aud || aud === "null") return c.json({ error: "Bad request" }, 400);
  const { id } = computerKey();
  const now = Math.floor(Date.now() / 1000);
  const name = hostname();
  const publicKey = publicKeyB64();
  const proof = signJws("ct-link-proof+jwt", { iss: `ct-computer:${id}`, aud, sub: id, jti: randomUUID(), iat: now, exp: now + 300, challenge, publicKey, origin: localOrigin(), name });
  c.header("Cache-Control", "no-store");
  return c.json({ proof, computerId: id, publicKey, origin: localOrigin(), name } satisfies LinkProofAnswer);
});

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

connectApp.post("/relay-config", async (c) => {
  const b = (await c.req.json().catch(() => null)) as Partial<Record<keyof RelayConfigInput, unknown>> | null;
  const str = (v: unknown) => (typeof v === "string" && v.length > 0 && v.length <= 4096 ? v : null);
  const brokerUrl = str(b?.brokerUrl);
  const owner = str(b?.owner);
  const computerId = str(b?.computerId);
  const host = str(b?.hostname);
  const tunnelToken = str(b?.tunnelToken);
  const brokerKey = str(b?.brokerKey);
  let key;
  try {
    key = brokerKey ? parseRelayKey(brokerKey) : null;
    if (brokerUrl && !/^https?:$/.test(new URL(brokerUrl).protocol)) throw new Error("scheme");
  } catch {
    key = null;
  }
  if (!brokerUrl || !owner || !computerId || !host || !HOSTNAME.test(host) || !tunnelToken || !brokerKey || !key) return c.json({ error: "Bad request" }, 400);
  if (computerId !== computerKey().id) return c.json({ error: "That link is for another computer" }, 400);
  await stopConnector(); // a relink brings a new tunnel token: the old tunnel stops first
  saveConnectState({
    brokerUrl,
    owner,
    localUser: c.get("user").username,
    computerId,
    name: hostname(),
    origin: localOrigin(),
    hostname: host.toLowerCase(),
    tunnelToken,
    relayKid: str(b?.brokerKid) ?? keyId(key),
    relayPublicKey: brokerKey,
    usedJti: connectState()?.usedJti ?? {},
  });
  startConnector();
  return c.json({ ok: true, hostname: host.toLowerCase() });
});

connectApp.delete("/relay-config", async (c) => {
  await unlinkConnector();
  return c.json({ ok: true });
});
