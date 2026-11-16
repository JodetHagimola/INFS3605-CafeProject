import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { hashPosPayload, normalizePosItems, verifyPosSignature } from '../lib/inventory-sales/pos.ts';

test('POS signature is verified over the exact raw body without timing-unsafe string comparison', () => {
  const body = Buffer.from('{"external_ref":"event-1"}');
  const secret = 'local-test-secret';
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  assert.equal(verifyPosSignature(body, signature, secret), true);
  assert.equal(verifyPosSignature(Buffer.from('{"external_ref":"event-2"}'), signature, secret), false);
  assert.equal(verifyPosSignature(body, `${signature}00`, secret), false);
  assert.equal(verifyPosSignature(body, signature, ''), false);
  assert.equal(hashPosPayload(body).length, 64);
});

test('POS line aggregation is deterministic and rejects invalid quantities', () => {
  assert.deepEqual(normalizePosItems([
    { product_name: 'Latte', quantity: 2 },
    { product_name: 'Flat White', quantity: 1 },
    { product_name: 'Latte', quantity: 3 },
  ]), [
    { product_name: 'Flat White', quantity: 1 },
    { product_name: 'Latte', quantity: 5 },
  ]);
  for (const items of [
    [],
    [{ product_name: 'Latte', quantity: 0 }],
    [{ product_name: 'Latte', quantity: 1000 }, { product_name: 'Latte', quantity: 1 }],
    [{ product_name: ' ', quantity: 1 }],
    [{ product_name: 'Latte', quantity: 1.5 }],
    [{ product_name: 'Latte', quantity: '2' }],
  ]) assert.equal(normalizePosItems(items), null);
});
