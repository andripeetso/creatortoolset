import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";
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
