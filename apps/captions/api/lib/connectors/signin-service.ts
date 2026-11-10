import { createHash, randomBytes } from "node:crypto";
import type { LoginKind } from "../../../contracts/connectors";
import { appFor, type Grant } from "./platforms";

/**
 * The platform sign-in service: an install with no Meta, Google or TikTok app of its own signs in through the
 * product site's apps (PLATFORM_SIGNIN_ORIGIN, by default creatortoolset.com; plugins/hosted/server/platform-signin.ts).
 * The browser goes there and to the platform; the site keeps the tokens under a one-time ticket that only this
 * install can redeem (PKCE: the install keeps the verifier, the site saw only its hash). From then on the install
 * reads the platform itself; the site sees the sign-in and each renewal (Google and TikTok renew with the app's
 * secret), never the numbers. An install with its own app in .env uses that and never asks the site.
 */

export type Issuer = "local" | "service";

const TIMEOUT = 10_000;
const KINDS: LoginKind[] = ["meta", "google", "tiktok"];
const none = (): Record<LoginKind, boolean> => ({ meta: false, google: false, tiktok: false });

/** The service's address, or "" on the site itself (it uses its own apps) and when PLATFORM_SIGNIN_ORIGIN is set to "off". */
export function serviceOrigin(): string {
  // a test run never asks the real site unless it names a service
  const fallback = process.env.NODE_ENV === "test" ? "" : "https://creatortoolset.com";
  const origin = (process.env.PLATFORM_SIGNIN_ORIGIN ?? fallback).trim().replace(/\/$/, "");
  if (!origin || origin === "off") return "";
  return origin === process.env.PUBLIC_ORIGIN?.trim().replace(/\/$/, "") ? "" : origin;
}

// ponytail: one cached answer per process; 10 minutes when it answered, 1 minute when it did not (an offline install never waits twice)
let cached: { at: number; ttl: number; logins: Record<LoginKind, boolean> } | null = null;

/** Which platform sign-ins the service offers (asked at most every few minutes, 3 s at most). */
export async function serviceLogins(): Promise<Record<LoginKind, boolean>> {
  const origin = serviceOrigin();
  if (!origin) return none();
  if (cached && Date.now() - cached.at < cached.ttl) return cached.logins;
  try {
    const res = await fetch(`${origin}/api/platform-signin`, { signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as Partial<Record<LoginKind, unknown>>;
    const logins = Object.fromEntries(KINDS.map((k) => [k, res.ok && body[k] === true])) as Record<LoginKind, boolean>;
    cached = { at: Date.now(), ttl: 10 * 60_000, logins };
  } catch {
    cached = { at: Date.now(), ttl: 60_000, logins: none() };
  }
  return cached.logins;
}

/** Test seam: forget the cached answer. */
export const forgetServiceLogins = () => void (cached = null);

/** Who signs a person in to this platform here: this server's own app, the service, or nobody. */
export async function issuerFor(kind: LoginKind): Promise<Issuer | null> {
  if (appFor(kind)) return "local";
  return (await serviceLogins())[kind] ? "service" : null;
}

/** Each platform's sign-in, on whichever side has it. */
export async function loginsOn(): Promise<Record<LoginKind, boolean>> {
  const remote = KINDS.some((k) => !appFor(k)) ? await serviceLogins() : none();
  return Object.fromEntries(KINDS.map((k) => [k, !!appFor(k) || remote[k]])) as Record<LoginKind, boolean>;
}

const b64sha = (s: string) => createHash("sha256").update(s).digest("base64url");

/** The service's start page for this sign-in, and the verifier the install keeps to redeem the ticket. */
export function serviceStart(kind: LoginKind, returnTo: string, state: string): { url: string; verifier: string } {
  const verifier = randomBytes(32).toString("base64url");
  const u = new URL(`${serviceOrigin()}/api/platform-signin/start/${kind}`);
  Object.entries({ return: returnTo, state, challenge: b64sha(verifier) }).forEach(([k, v]) => u.searchParams.set(k, v));
  return { url: u.toString(), verifier };
}

async function post(path: string, body: unknown): Promise<Grant> {
  const res = await fetch(`${serviceOrigin()}/api/platform-signin${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT),
  });
  const j = (await res.json().catch(() => ({}))) as Partial<Grant> & { error?: string };
  if (!res.ok || typeof j.access_token !== "string") throw new Error(j.error || `The sign-in service answered ${res.status}`);
  return j as Grant;
}

/** The tokens the service keeps under a sign-in's ticket (single use, minutes). */
export const serviceRedeem = (ticket: string, verifier: string) => post("/redeem", { ticket, verifier });

/** New tokens for a login the service issued. */
export const serviceRefresh = (kind: "google" | "tiktok", refresh: string) => post("/refresh", { kind, refresh });
