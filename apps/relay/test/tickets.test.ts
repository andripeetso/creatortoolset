import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { checkAccountToken, issueTicket, mintAccountToken, TICKET_TTL, TokenError, verifyTicket } from '../src/tickets.ts';

const relay = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');
const base = { sub: 'acct-1', env: 'comp-1', aud: 'comp-1.tunnels.test.example' };
const now = 1_800_000_000;
const ok = (ticket: string, over: Partial<Parameters<typeof verifyTicket>[1]> = {}) =>
  verifyTicket(ticket, {
    relayPublicKey: relay.publicKey,
    hostname: base.aud,
    computerId: base.env,
    owner: base.sub,
    now,
    consume: () => true,
    ...over,
  });

test('a ticket verifies once for its host, computer and owner', () => {
  const t = issueTicket(relay.privateKey, base, now);
  const seen = new Set<string>();
  const consume = (jti: string) => {
    if (seen.has(jti)) return false;
    seen.add(jti);
    return true;
  };
  assert.equal(ok(t, { consume }).sub, 'acct-1');
  assert.throws(() => ok(t, { consume }), /already used/); // reused jti
});

test('a ticket is refused for the wrong host, computer or owner', () => {
  const t = issueTicket(relay.privateKey, base, now);
  assert.throws(() => ok(t, { hostname: 'comp-2.tunnels.test.example' }), /wrong host/);
  assert.throws(() => ok(t, { computerId: 'comp-2' }), /wrong computer/);
  assert.throws(() => ok(t, { owner: 'acct-2' }), /wrong account/);
});

test('a ticket is refused after 120 s and when its lifetime is longer than that', () => {
  const t = issueTicket(relay.privateKey, base, now);
  assert.throws(() => ok(t, { now: now + TICKET_TTL }), /expired/);
  assert.doesNotThrow(() => ok(t, { now: now + TICKET_TTL - 1 }));
  // a relay build that wrote a longer ticket: signed correctly, still refused
  const body = Buffer.from(JSON.stringify({ ...base, iat: now, exp: now + 121, jti: randomBytes(8).toString('hex') })).toString('base64url');
  const long = `${body}.${sign(null, Buffer.from(body), relay.privateKey).toString('base64url')}`;
  assert.throws(() => ok(long), /expired/);
});

test('a forged or edited ticket is refused', () => {
  const t = issueTicket(relay.privateKey, base, now);
  const [body, sig] = t.split('.');
  const edited = Buffer.from(JSON.stringify({ ...base, sub: 'acct-2', iat: now, exp: now + 60, jti: 'x' })).toString('base64url');
  assert.throws(() => ok(`${edited}.${sig}`), /bad signature/);
  assert.throws(() => ok(`${body}.${sig}x`), /bad signature/);
  const forged = issueTicket(other.privateKey, base, now);
  assert.throws(() => ok(forged), /bad signature/);
  assert.throws(() => ok('not-a-ticket'), /malformed/);
  assert.throws(() => ok(`${t}.extra`), /malformed/);
});

const secret = randomBytes(32);
test('an account token checks out for its secret and expires', () => {
  const t = mintAccountToken(secret, 'acct-1', now);
  assert.equal(checkAccountToken(secret, t, now), 'acct-1');
  assert.throws(() => checkAccountToken(secret, t, now + 3600), TokenError);
  assert.throws(() => checkAccountToken(randomBytes(32), t, now), /bad mac/);
  const [body, tag] = t.split('.');
  const edited = Buffer.from(JSON.stringify({ sub: 'acct-2', exp: now + 60 })).toString('base64url');
  assert.throws(() => checkAccountToken(secret, `${edited}.${tag}`, now), /bad mac/);
  assert.throws(() => checkAccountToken(secret, `${body}`, now), /malformed/);
});
