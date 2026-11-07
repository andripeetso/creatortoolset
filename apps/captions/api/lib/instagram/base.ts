import path from "node:path";
import { env } from "../env";
import { USERNAME_RE } from "../../users";

/** Where the Analyzer keeps its data, each account's own files (apify.json, idea boards), and its error type. */

export const IG_ROOT = path.join(env.dataDir, "instagram");

/** Per-user folder under users/. Usernames match the accounts file. */
export function igCredsDir(username: string): string {
  const u = username.toLowerCase();
  if (!USERNAME_RE.test(u)) throw new Error("Invalid username");
  return path.join(IG_ROOT, "users", u);
}

export function igUserFile(username: string, name: string): string {
  return path.join(igCredsDir(username), name);
}

/** The User-Agent for media downloads from Instagram's CDN. */
export const DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

export type InstagramErrorCode = "APIFY" | "GRAPH" | "RATE_LIMIT" | "NOT_FOUND" | "BLOCKED" | "CANCELLED" | "FAILED";

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly code: InstagramErrorCode,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "InstagramError";
  }
}
