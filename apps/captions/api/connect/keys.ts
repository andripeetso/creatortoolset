import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../lib/env";

// This computer's own Ed25519 key. It signs the link proof; its id (the first 32 hex characters of the SHA-256 of the
// public key) is this computer's id on the broker. The private key stays in the data folder, mode 0600.
let cached: { privateKey: KeyObject; publicKey: KeyObject; id: string } | null = null;

export function computerKey() {
  if (cached) return cached;
  const file = path.join(env.dataDir, "connect-key.der");
  let privateKey: KeyObject;
  if (existsSync(file)) {
    privateKey = createPrivateKey({ key: readFileSync(file), format: "der", type: "pkcs8" });
  } else {
    privateKey = generateKeyPairSync("ed25519").privateKey;
    mkdirSync(env.dataDir, { recursive: true });
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "der" }), { mode: 0o600 });
  }
  const publicKey = createPublicKey(privateKey);
  cached = { privateKey, publicKey, id: keyId(publicKey) };
  return cached;
}

/** The id the broker knows this key by: the first 32 hex characters of the SHA-256 of its SPKI DER. */
export function keyId(publicKey: KeyObject): string {
  return createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex").slice(0, 32);
}

/** A key from base64 SPKI DER (the broker's relay key). Only Ed25519 is accepted. */
export function parseRelayKey(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, "base64"), format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
  return key;
}

/** This computer's public key as base64 SPKI DER (what the connect service stores at link). */
export const publicKeyB64 = (k: KeyObject = computerKey().publicKey) => k.export({ type: "spki", format: "der" }).toString("base64");

/** A compact JWS, EdDSA, signed by this computer's key. */
export function signJws(typ: string, payload: object, key: KeyObject = computerKey().privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const p = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}

/** The payload of a compact EdDSA JWS of this `typ` signed by `key`, or null for anything else. */
export function verifyJws(token: string, typ: string, key: KeyObject): Record<string, unknown> | null {
  const parts = typeof token === "string" ? token.split(".") : [];
  if (parts.length !== 3 || !parts.every((x) => /^[A-Za-z0-9_-]+$/.test(x))) return null;
  try {
    const h = JSON.parse(Buffer.from(parts[0], "base64url").toString()) as Record<string, unknown>;
    if (h.alg !== "EdDSA" || h.typ !== typ) return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2], "base64url"))) return null;
    const p = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as unknown;
    return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
