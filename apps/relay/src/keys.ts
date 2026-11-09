import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// The relay's Ed25519 key signs tickets. The key comes from RELAY_SIGNING_KEY (PKCS#8 DER, base64) when set, else
// from a file in the data dir, which is generated on first boot. Anything that is not Ed25519 throws.
export function loadSigningKey(env: string | undefined, file: string): { privateKey: KeyObject; publicKey: KeyObject; kid: string } {
  if (env) return fromPrivate(createPrivateKey({ key: Buffer.from(env, 'base64'), format: 'der', type: 'pkcs8' }));
  if (existsSync(file)) return fromPrivate(createPrivateKey({ key: readFileSync(file), format: 'der', type: 'pkcs8' }));
  const { privateKey } = generateKeyPairSync('ed25519');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'der' }), { mode: 0o600 });
  return fromPrivate(privateKey);
}

function fromPrivate(privateKey: KeyObject) {
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('the relay signing key must be Ed25519');
  const publicKey = createPublicKey(privateKey);
  return { privateKey, publicKey, kid: keyId(publicKey) };
}

// A computer's public key, from base64 SPKI DER. Only Ed25519 is accepted.
export function parsePublicKey(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('not an Ed25519 key');
  return key;
}

export function publicKeyB64(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

// A key's id: the first 32 hex characters of its SHA-256. A computer's id is its key's id, so one key is one computer.
export function keyId(key: KeyObject): string {
  return createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 32);
}
