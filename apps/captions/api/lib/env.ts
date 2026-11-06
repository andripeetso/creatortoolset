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
};
