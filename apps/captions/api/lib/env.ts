import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";
import type { ServerKind } from "../../contracts/work";

// All vars are optional: the app runs fully without auth.
export const env = {
  appSecret: process.env.APP_SECRET ?? "",
  isProduction: process.env.NODE_ENV === "production",
  cookieDomain: (process.env.COOKIE_DOMAIN ?? "").trim(),
  dataDir: process.env.DATA_DIR || path.join(homedir(), ".caption-studio"),
  objectStorageEndpoint: process.env.OBJECT_STORAGE_ENDPOINT ?? "",
  objectStorageRegion: process.env.OBJECT_STORAGE_REGION ?? "",
  objectStorageBucket: process.env.OBJECT_STORAGE_BUCKET ?? "",
  objectStorageAccessKey: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "",
  objectStorageSecretKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "",
  objectStorageForcePathStyle:
    process.env.OBJECT_STORAGE_FORCE_PATH_STYLE === "true",
  adminUsername: (process.env.ADMIN_USERNAME || "admin").toLowerCase(),
  // the shared community catalog, read like a plugin directory; an empty value turns it off
  packCatalogUrl: (process.env.PACK_CATALOG_URL ?? "https://creatortoolset.com").trim(),
  // the connect broker this computer links to (api/connect); empty = linking is off
  connectUrl: process.env.CT_CONNECT_URL ?? "",
};

/**
 * What this server is (CT_SERVER): `mac` the server built into the Mac app (one person, their own computer), `server`
 * a box someone runs for themselves or their team, opened by its address, `cloud` Creator Toolset Cloud (reserved: many
 * separate teams). Unset, the older settings decide: CT_MODE=hosted reads as a Server, CT_LOCAL=1 (the Mac app sets it)
 * as This Mac, anything else as a Server. Nothing else reads CT_SERVER, CT_MODE or CT_LOCAL for the kind.
 */
export type { ServerKind };
let warned = false;
export function serverKind(): ServerKind {
  const set = process.env.CT_SERVER?.trim().toLowerCase();
  if (set === "mac" || set === "server" || set === "cloud") return set;
  if (set && !warned) {
    warned = true;
    console.warn(`CT_SERVER=${set} is not mac, server or cloud: read from the older settings instead`);
  }
  if (process.env.CT_MODE?.trim() === "hosted") return "server";
  return process.env.CT_LOCAL === "1" ? "mac" : "server";
}
/** Accounts and team features: Team, invites, server keys, Team use, budgets, sign-in providers. */
export const hasTeam = (): boolean => serverKind() !== "mac";
/** Guards against tenants who don't trust each other: view-as, no local model, no server disks, no LAN addresses. */
export const isCloud = (): boolean => serverKind() === "cloud";
/** The descriptor's `platform: "hosted"` keeps its old meaning for the iPhone app (an account server, no computer). */
export const hostedPlatform = (): boolean => isCloud() || process.env.CT_MODE?.trim() === "hosted";

/**
 * Whether this process keeps what a restart must not lose (AI answers being written: lib/mac-claude.ts, their job
 * tokens: auth.ts) and takes it up again at boot: a real server, and tests. Never a dev server: it shares its data
 * folder with one, and would take over, or write over, what that server is running.
 */
export const keepsOverRestart = (): boolean => process.env.NODE_ENV === "production" || process.env.NODE_ENV === "test";
