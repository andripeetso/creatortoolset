import "dotenv/config";
import { homedir } from "node:os";
import path from "node:path";

// All vars are optional: the app runs fully without auth or a database.
// If a feature starts depending on one of these, validate it at the call
// site (e.g. getDb throws when DATABASE_URL is unset).
export const env = {
  appId: process.env.APP_ID ?? "",
  appSecret: process.env.APP_SECRET ?? "",
  isProduction: process.env.NODE_ENV === "production",
  cookieDomain: (process.env.COOKIE_DOMAIN ?? "").trim(),
  databaseUrl: process.env.DATABASE_URL ?? "",
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
 * Hosted mode (CT_MODE=hosted): this server is a hosted one, rented as a cloud or run for other people. Hosted-only
 * features (teams, admin, view-as) are meant for it. Local (the default) is one person's own machine.
 * CT_LOCAL is a transport rule (which hosts answer) and does not change this.
 */
export function hostedMode(): boolean {
  return process.env.CT_MODE?.trim() === "hosted";
}
