import { Hono } from "hono";
import type { Device } from "../contracts/providers";
import type { AuthVars } from "./auth";
import { relayRoutes } from "./lib/mac-claude";
import { deviceOf, deviceForToken, isOnline, listDevices, pairDevice, renameDevice, revokeDevice } from "./lib/devices";
import { findUser } from "./users";

/**
 * The Macs that run AI jobs (lib/devices.ts). Routes (boot.ts mounts them at /api/devices):
 *   POST /api/devices body {name, version?} → {device, token}   pair this account's Mac (the token is shown once)
 *   GET /api/devices → Array<Device & {online}>                  own; admins also the workspace's and admins' Macs
 *   PATCH /api/devices/:id {name}                                owner or admin
 *   DELETE /api/devices/:id                                      owner or admin
 *   POST /api/devices/relay/wait | /report | /:id/text | /:id/step | /:id/done | /:id/fail
 *       the Mac app's side, Authorization: Bearer ctd_… (boot.ts checks it before the cookie gate); the same bodies
 *       as the relay routes in mac-claude.ts (relayRoutes)
 */

export const devicesApp = new Hono<{ Variables: AuthVars }>();

devicesApp.route("/relay", relayRoutes((c) => deviceForToken(c.req.header("authorization"))?.id ?? null));

/** Accounts only: not a share-link visitor. */
const signedIn = (u: AuthVars["user"]) => u.role !== "visitor";
/** Names the workspace's scope uses (usage keys, the workspace's Mac owner): no account may take them. */
const RESERVED = new Set(["workspace"]);
const online = (d: Device) => ({ ...d, online: isOnline(d.id) });
/** Admins' Macs are listed to admins: the owner's role decides (the owner may have been demoted since). */
const isAdminOwner = (owner: string) => findUser(owner)?.role === "admin";

devicesApp.post("/", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (RESERVED.has(u.username)) return c.json({ error: "This account can't pair a Mac" }, 400);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "Name the Mac" }, 400);
  const version = typeof b?.version === "string" ? b.version.slice(0, 40) : undefined;
  const { device, token } = pairDevice(u.username, name, version);
  return c.json({ device, token });
});

devicesApp.get("/", (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const admin = u.role === "admin";
  const list = listDevices((d) => d.owner === u.username || (admin && (d.owner === "workspace" || isAdminOwner(d.owner))));
  return c.json(list.map(online));
});

/** The device an account may change: its own, or any for an admin. */
function manageable(u: AuthVars["user"], id: string): Device | null {
  const d = deviceOf(id);
  if (!d) return null;
  return d.owner === u.username || u.role === "admin" ? d : null;
}

devicesApp.patch("/:id", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const id = c.req.param("id");
  if (!manageable(u, id)) return c.json({ error: "Not found" }, 404);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = typeof b?.name === "string" ? b.name.trim().slice(0, 60) : "";
  if (!name) return c.json({ error: "Name the Mac" }, 400);
  const renamed = renameDevice(id, name);
  return renamed ? c.json(online(renamed)) : c.json({ error: "Not found" }, 404);
});

devicesApp.delete("/:id", (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const id = c.req.param("id");
  if (!manageable(u, id)) return c.json({ error: "Not found" }, 404);
  revokeDevice(id);
  return c.json({ ok: true });
});
