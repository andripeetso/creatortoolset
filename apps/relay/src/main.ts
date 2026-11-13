import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createCloudflare } from './cloudflare.ts';
import { openDb } from './db.ts';
import { loadSigningKey } from './keys.ts';
import { freeLimit } from './limits.ts';
import { reap } from './reaper.ts';
import { startServer } from './server.ts';

// Everything comes from the environment (see .env.example). Nothing is read from the repo.
const env = process.env;
const need = (k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is not set`);
  return v;
};

const dataDir = env.RELAY_DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const accountSecret = Buffer.from(need('RELAY_ACCOUNT_SECRET'));
if (accountSecret.length < 32) throw new Error('RELAY_ACCOUNT_SECRET must be at least 32 bytes');

// AI apps through this broker (gateway.ts): on only when its secret is set.
const grantSecret = env.RELAY_GRANT_SECRET ? Buffer.from(env.RELAY_GRANT_SECRET) : null;
if (grantSecret && grantSecret.length < 32) throw new Error('RELAY_GRANT_SECRET must be at least 32 bytes');

const cf = createCloudflare({
  accountId: need('CLOUDFLARE_ACCOUNT_ID'),
  zoneId: need('CLOUDFLARE_ZONE_ID'),
  token: need('CLOUDFLARE_API_TOKEN'),
});
const now = () => Math.floor(Date.now() / 1000);
const deps = {
  db: openDb(join(dataDir, 'relay.sqlite')),
  cf,
  now,
  limitFor: freeLimit(Number(env.RELAY_FREE_LIMIT ?? 3)),
  tunnelDomain: need('RELAY_TUNNEL_DOMAIN'),
  publicUrl: need('RELAY_PUBLIC_URL'),
  accountSecret,
  signing: loadSigningKey(env.RELAY_SIGNING_KEY, join(dataDir, 'relay-signing-key.der')),
  ...(grantSecret ? { gateway: { secret: grantSecret, openaiChallenge: env.RELAY_OPENAI_APPS_CHALLENGE } } : {}),
};

const port = Number(env.PORT ?? 44610);
const server = await startServer(deps, port, env.RELAY_LISTEN_HOST ?? '127.0.0.1');
console.log(`relay listening on ${port} (key ${deps.signing.kid})`);

// The reaper. Dry run unless RELAY_REAP_DRY_RUN=0: the first real sweep is a human's decision.
const reapOpts = { dryRun: env.RELAY_REAP_DRY_RUN !== '0', afterSeconds: Number(env.RELAY_REAP_AFTER ?? 1800) };
setInterval(() => {
  reap(deps, reapOpts).catch((e) => console.error('reap failed', (e as Error).message));
}, 5 * 60 * 1000).unref();

const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
