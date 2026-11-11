import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env, hostedMode } from "./env";
import type { SignInCode } from "../users";

/**
 * The sign-in code (Settings → Account) and the lock on wrong tries. The routes are in api/auth.ts.
 *
 * - The code: an authenticator app's 6-digit code (RFC 6238: HMAC-SHA1, 30-second steps, one step either side), from
 *   a 20-byte secret kept with the account in users.json, as the password hash is. A step that signed in never works
 *   again. Ten recovery codes, kept as sha256, each works once.
 * - The step token: a right password for an account that needs the code answers with one, never a cookie. Only
 *   POST /api/auth/code takes it, for 5 minutes, for that account and its current password.
 * - The lock: per account, from any address. Five wrong passwords or codes in a row are free; from the fifth on each
 *   one waits twice as long as the last (1 min up to 1 h). It is cleared by a sign-in that sets a cookie, by an admin,
 *   by a day without a wrong try, or by a restart (it is kept in memory only).
 */

const STEP_S = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 without padding: how authenticator apps take a secret. */
export function base32(buf: Buffer): string {
  let bits = 0;
  let v = 0;
  let out = "";
  for (const b of buf) {
    v = (v << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(v >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return bits ? out + B32[(v << (5 - bits)) & 31] : out;
}

/** The 6-digit code of one 30-second step. */
export function codeAt(secret: Buffer, step: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = createHmac("sha1", secret).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** The step a typed code belongs to (this one, or one either side), or null. */
export function stepOf(secretHex: string, typed: string, now = Date.now()): number | null {
  const code = typed.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const t = Math.floor(now / 1000 / STEP_S);
  for (const s of [t, t - 1, t + 1]) if (timingSafeEqual(Buffer.from(codeAt(Buffer.from(secretHex, "hex"), s)), Buffer.from(code))) return s;
  return null;
}

const recoveryHash = (typed: string) => createHash("sha256").update(typed.toLowerCase().replace(/[^a-z2-7]/g, "")).digest("hex");

/**
 * A typed code checked against the account's: its code with that step spent, or with that recovery code gone. Null:
 * wrong, or a step that was used already.
 */
export function checkCode(code: SignInCode, typed: string): SignInCode | null {
  const step = stepOf(code.secret, typed);
  if (step !== null) return step > code.lastStep ? { ...code, lastStep: step } : null;
  const h = recoveryHash(typed);
  return typed.trim() && code.recovery.includes(h) ? { ...code, recovery: code.recovery.filter((x) => x !== h) } : null;
}

// a secret being set up, by account: until its first code confirms it (10 minutes, memory only)
const pending = new Map<string, { secret: string; expiresAt: number }>();

/** A new secret to scan: the otpauth address the QR holds, and the secret as text for typing it in. */
export function newSecret(username: string, label: string): { secret: string; uri: string } {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expiresAt <= now) pending.delete(k);
  const raw = randomBytes(20);
  pending.set(username, { secret: raw.toString("hex"), expiresAt: now + 10 * 60_000 });
  const secret = base32(raw);
  const issuer = "Creator Toolset";
  return { secret, uri: `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` };
}

/** The first code of the secret being set up: the account's new code and its ten recovery codes (shown once), or null. */
export function confirmSecret(username: string, typed: string): { code: SignInCode; recovery: string[] } | null {
  const p = pending.get(username);
  const step = p && p.expiresAt > Date.now() ? stepOf(p.secret, typed) : null;
  if (step === null) return null;
  pending.delete(username);
  const recovery = Array.from({ length: 10 }, () => {
    const s = base32(randomBytes(7)).slice(0, 10).toLowerCase();
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
  return { code: { secret: p!.secret, recovery: recovery.map(recoveryHash), lastStep: step }, recovery };
}

// step tokens from the password step (5 minutes, memory only)
const STEP_MS = 5 * 60_000;
const steps = new Map<string, { username: string; stamp: string; setup: boolean; expiresAt: number }>();

/** `setup`: the account has no code yet and this server asks everyone for one, so the token sets one up. */
export function mintStep(username: string, stamp: string, setup: boolean): string {
  const now = Date.now();
  for (const [k, v] of steps) if (v.expiresAt <= now) steps.delete(k);
  const token = randomBytes(32).toString("base64url");
  steps.set(token, { username, stamp, setup, expiresAt: now + STEP_MS });
  return token;
}

export const stepFor = (token: unknown) => {
  const s = typeof token === "string" ? steps.get(token) : undefined;
  return s && s.expiresAt > Date.now() ? s : null;
};
export const spendStep = (token: string) => void steps.delete(token);

// the lock: wrong tries by account ("?<typed name>" for a name no account has, so the answer is the same either way)
const FREE = 5;
const DAY = 86_400_000;
const tries = new Map<string, { n: number; at: number; until: number }>();

/** Ms until this account may try again; 0 = now. */
export function waitFor(key: string, now = Date.now()): number {
  const t = tries.get(key);
  return t && now - t.at < DAY ? Math.max(0, t.until - now) : 0;
}

/** One wrong password or code. Returns how many in a row. */
export function wrongTry(key: string, now = Date.now()): number {
  const old = tries.get(key);
  const n = (old && now - old.at < DAY ? old.n : 0) + 1;
  tries.delete(key); // set again below, so the oldest stay first
  tries.set(key, { n, at: now, until: n >= FREE ? now + Math.min(60, 2 ** (n - FREE)) * 60_000 : 0 });
  // ponytail: names no account has are dropped oldest first past 10,000; accounts' own entries are never dropped
  if (tries.size > 10_000) for (const k of tries.keys()) if (k.startsWith("?")) {
    tries.delete(k);
    break;
  }
  return n;
}

export const clearTries = (key: string) => void tries.delete(key);

// an admin asked everyone on this hosted server for a code (Settings → Admin)
const REQUIRED_FILE = path.join(env.dataDir, "sign-in-code.json");
let required = (() => {
  try {
    return JSON.parse(readFileSync(REQUIRED_FILE, "utf8")).required === true;
  } catch {
    return false;
  }
})();

export const codeRequired = () => hostedMode() && required;

export function setCodeRequired(on: boolean): void {
  required = on;
  writeFileSync(REQUIRED_FILE, JSON.stringify({ required: on }), { mode: 0o600 });
}
