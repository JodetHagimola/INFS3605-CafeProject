import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSaleIntent, displayAmount, displaySaleTime } from '../lib/inventory-sales/model.ts';
const valid = { id: '12345678-1234-4234-8234-123456789abc', product: 'Latte', quantity: 2 };
test('accepts a complete sale request and rejects incomplete or malformed requests', () => {
  assert.deepEqual(parseSaleIntent(valid), valid);
  for (const quantity of [0, -1, 1.5, 1001, NaN, Infinity, '2'])
    assert.equal(parseSaleIntent({ ...valid, quantity }), null);
  for (const product of ['', ' ', null, 'x'.repeat(121)])
    assert.equal(parseSaleIntent({ ...valid, product }), null);
  assert.equal(parseSaleIntent({ ...valid, id: 'not-a-sale-reference' }), null);
  assert.equal(parseSaleIntent(null), null);
});
test('formatting is stable without browser-specific date or number conventions', () => {
  assert.equal(displayAmount('20000.00'), '20000');
  assert.equal(displayAmount(0), '0');
  assert.equal(displayAmount('0.125000'), '0.125');
  assert.equal(displayAmount(Infinity), '—');
  assert.equal(displaySaleTime('2026-11-01T13:00:00+00:00'), '2026-11-01 13:00:00 UTC');
  assert.equal(displaySaleTime('invalid'), '—');
});
