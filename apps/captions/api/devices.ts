import { Hono, type Context } from "hono";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LOAD_PREFERENCES, type Balance, type Device } from "../contracts/providers";
import { parseKinds, RESOLVE_KIND, type DeviceClaim } from "../contracts/devices";
import type { AuthVars } from "./auth";
import { claimableBy } from "./editor/engine";
import { beatForDevice, claimForDevice, doneForDevice, failForDevice } from "./editor/worker";
import { mayClaim, type WorkerSeen } from "./lib/balance";
import { env } from "./lib/env";
import { relayRoutes } from "./lib/mac-claude";
import { deviceOf, deviceForToken, forViewer, isOnline, listDevices, moveProviders, pairDevice, renameDevice, revokeDevice, setDeviceKinds, touchDevice } from "./lib/devices";
import { findUser } from "./users";
import { resolveGranted } from "./lib/packs";
import { storageApp } from "./devices-storage";

/**
 * The Macs that run AI jobs (lib/devices.ts). Routes (boot.ts mounts them at /api/devices):
 *   POST /api/devices body {name, version?} → {device, token}   pair this account's Mac (the token is shown once)
 *   GET /api/devices → Array<Device & {online}>                  own; admins also the workspace's and admins' Macs
 *   PATCH /api/devices/:id {name}                                owner or admin
 *   DELETE /api/devices/:id                                      owner or admin
 *   POST /api/devices/relay/editor/claim {kinds}                 the device declares its editor step kinds and takes one (contracts/devices.ts)
 *   POST /api/devices/relay/editor/job/:id/beat | /done | /fail  the device's step, same token
 *   POST /api/devices/relay/wait | /report | /:id/text | /:id/step | /:id/done | /:id/fail
 *       the Mac app's side, Authorization: Bearer ctd_… (boot.ts checks it before the cookie gate); the same bodies
 *       as the relay routes in mac-claude.ts (relayRoutes)
 */

export const devicesApp = new Hono<{ Variables: AuthVars }>();

/** The device behind a ctd_ token on an editor route; a 401 when there is none. Keeps the device here (it is alive). */
function deviceCaller(c: Context): Device | null {
  const d = deviceForToken(c.req.header("authorization"));
  if (d) touchDevice(d.id);
  return d;
}
/** A job id from the path; anything that is not a positive integer matches no job. */
const jobId = (c: Context): number => {
  const n = Number(c.req.param("id"));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

// registered before the relay mount below, so these answer first (the relay's middleware is for its own routes)
devicesApp.post("/relay/editor/claim", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const kinds = parseKinds(b?.kinds);
  if (!kinds) return c.json({ error: "kinds: a list of step kinds" }, 400);
  // what the device runs is stored with it, so Settings → Devices can show it; a claim with none claims nothing
  // the Resolve bridge is switched on by a pack with Resolve items (the owner's Resolve plug-in or a downloaded one)
  const granted = kinds.includes(RESOLVE_KIND) && (await resolveGranted(d.owner));
  const claimable = claimableBy(kinds).filter((k) => k !== RESOLVE_KIND || granted);
  setDeviceKinds(d.id, claimable);
  return c.json({ job: claimForDevice(d, await balancedKinds(d, claimable)) } satisfies DeviceClaim);
});
devicesApp.post("/relay/editor/job/:id/beat", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: beatForDevice(d.id, jobId(c)) });
});
devicesApp.post("/relay/editor/job/:id/done", (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  return c.json({ ok: doneForDevice(d.id, jobId(c)) });
});
devicesApp.post("/relay/editor/job/:id/fail", async (c) => {
  const d = deviceCaller(c);
  if (!d) return c.json({ error: "Unauthorized" }, 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const why = typeof b?.error === "string" && b.error ? b.error : "The device could not run this step";
  return c.json({ ok: failForDevice(d.id, jobId(c), why) });
});

devicesApp.route("/relay", relayRoutes((c) => deviceForToken(c.req.header("authorization"))?.id ?? null));
devicesApp.route("/storage", storageApp);

/** Load balancing (Settings → Devices): on/off and each of the account's computers' preference, in $DATA_DIR/balance/<user>.json. Admins only. */
const balanceFile = (user: string) => path.join(env.dataDir, "balance", `${user}.json`);
const ALLOWED_WEIGHTS = new Set<number>(LOAD_PREFERENCES.map((x) => x.value));
async function readBalance(user: string): Promise<Balance> {
  try {
    const b = JSON.parse(await readFile(balanceFile(user), "utf-8")) as Partial<Balance>;
    return { on: b.on !== false, weights: b.weights && typeof b.weights === "object" ? b.weights : {} };
  } catch {
    return { on: true, weights: {} };
  }
}

devicesApp.get("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (u.role !== "admin") return c.json({ error: "Only an admin sees load balancing" }, 403);
  return c.json(await readBalance(u.username));
});

devicesApp.put("/balance", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  if (u.role !== "admin") return c.json({ error: "Only an admin changes load balancing" }, 403);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const cur = await readBalance(u.username);
  if (typeof b?.on === "boolean") cur.on = b.on;
  if (b?.weights && typeof b.weights === "object") {
    for (const [id, v] of Object.entries(b.weights as Record<string, unknown>)) {
      if (deviceOf(id)?.owner !== u.username || typeof v !== "number" || !ALLOWED_WEIGHTS.has(v)) return c.json({ error: `Bad weight for ${id}` }, 400);
      cur.weights[id] = v;
    }
  }
  await mkdir(path.dirname(balanceFile(u.username)), { recursive: true });
  const tmp = `${balanceFile(u.username)}.tmp-${process.pid}`;
  await writeFile(tmp, JSON.stringify(cur, null, 2));
  await rename(tmp, balanceFile(u.username));
  return c.json(cur);
});

/** The same window as isOnline (lib/devices.ts): a computer that has not been heard from in 40 s is not a candidate. */
const ONLINE_MS = 40_000;
/**
 * The kinds `d` may take now under load balancing (lib/balance.ts): a kind goes to the best free computer among the
 * account's own. One computer (or balancing off) takes all of them.
 */
async function balancedKinds(d: Device, kinds: string[]): Promise<string[]> {
  const own = listDevices((x) => x.owner === d.owner);
  if (own.length < 2) return kinds;
  const now = Date.now();
  const workers: WorkerSeen[] = own
    .filter((x) => x.report?.machine)
    .map((x) => ({
      host: x.id,
      at: x.id === d.id ? now : x.lastSeen ?? 0,
      machine: x.report!.machine,
      never: kinds.filter((k) => !(x.kinds ?? []).includes(k)),
    }));
  const balance = await readBalance(d.owner);
  return kinds.filter((k) => mayClaim(k, d.id, workers, balance, now, ONLINE_MS));
}

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
  const { device, token, replaced } = pairDevice(u.username, name, version);
  // the same Mac paired again: its providers now run on the new record
  if (replaced.length) await moveProviders(u.username, replaced, device.id);
  return c.json({ device, token });
});

devicesApp.get("/", (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const admin = u.role === "admin";
  const list = listDevices((d) => d.owner === u.username || (admin && (d.owner === "workspace" || isAdminOwner(d.owner))));
  return c.json(list.map((d) => online(forViewer(u.username, d))));
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

devicesApp.delete("/:id", async (c) => {
  const u = c.get("user");
  if (!signedIn(u)) return c.json({ error: "Not for guests" }, 403);
  const id = c.req.param("id");
  if (!manageable(u, id)) return c.json({ error: "Not found" }, 404);
  await revokeDevice(id);
  return c.json({ ok: true });
});
