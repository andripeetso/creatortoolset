import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { checkAccountToken, mintAccountToken, TokenError } from '../src/tickets.ts';

const now = 1_800_000_000;

const secret = randomBytes(32);
test('an account token checks out for its secret and expires', () => {
  const t = mintAccountToken(secret, 'acct-1', now);
  assert.deepEqual(checkAccountToken(secret, t, now), { account: 'acct-1' });
  assert.deepEqual(checkAccountToken(secret, mintAccountToken(secret, 'acct-1', now, 'k1'), now), { account: 'acct-1', jkt: 'k1' });
  assert.throws(() => checkAccountToken(secret, t, now + 3600), TokenError);
  assert.throws(() => checkAccountToken(randomBytes(32), t, now), /bad mac/);
  const [body, tag] = t.split('.');
  const edited = Buffer.from(JSON.stringify({ sub: 'acct-2', exp: now + 60 })).toString('base64url');
  assert.throws(() => checkAccountToken(secret, `${edited}.${tag}`, now), /bad mac/);
  assert.throws(() => checkAccountToken(secret, `${body}`, now), /malformed/);
});
