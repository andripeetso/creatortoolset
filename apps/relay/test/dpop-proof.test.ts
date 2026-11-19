import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkProof, type JtiSpend } from '../src/dpop-proof.ts';
import { dpopVectors } from './dpop-vectors.ts';

test('dpop proof: every shared vector gets its answer (the computer runs the same ones)', () => {
  for (const v of dpopVectors()) {
    const r = checkProof(v);
    assert.equal(r.ok ? 'ok' : r.code, v.expect, v.name);
  }
});

test('dpop proof: the jti is spent only once every other check passed, and the store answer is kept', () => {
  const asked: string[] = [];
  const spend = (answer: 'ok' | 'replay' | 'busy'): JtiSpend => (jkt, jti, untilS, nowS) => {
    asked.push(jti);
    assert.equal(untilS, nowS + 601);
    return answer;
  };
  for (const v of dpopVectors()) {
    asked.length = 0;
    const r = checkProof(v, spend('ok'));
    assert.equal(asked.length, v.expect === 'ok' ? 1 : 0, v.name);
    assert.equal(r.ok ? 'ok' : r.code, v.expect, v.name);
  }
  const good = dpopVectors()[0];
  assert.deepEqual(checkProof(good, spend('replay')), { ok: false, code: 'replay' });
  assert.deepEqual(checkProof(good, spend('busy')), { ok: false, code: 'busy' });
});
