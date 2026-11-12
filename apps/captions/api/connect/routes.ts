import { Hono } from "hono";
import { hostname } from "node:os";
import { env } from "../lib/env";
import { findUser, type SessionUser } from "../users";
import type { AuthVars } from "../auth";
import { BrokerError, accountOfToken, linkThisComputer, pollDeviceGrant, startDeviceGrant } from "./broker";
import { startConnector } from "./connector";
import { connectState } from "./state";

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
