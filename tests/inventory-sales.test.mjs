import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSaleIntent, parseSaleReceipt, displayAmount, displaySaleTime } from '../lib/inventory-sales/model.ts';
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
  assert.equal(displaySaleTime('2026-11-01T13:00:00+00:00'), '2 Nov 2026, 12:00 am');
  assert.equal(displaySaleTime('invalid'), '—');
});
test('a saved sale receipt must match its request reference and contain ingredient changes', () => {
  const receipt = {
    sale_id: valid.id,
    product_name: valid.product,
    quantity: valid.quantity,
    replayed: false,
    changes: [{ ingredient_id: '1', name: 'Milk', unit: 'ml', amount: '300', before: '1000', after: '700' }],
  };
  assert.deepEqual(parseSaleReceipt(receipt, valid.id), receipt);
  assert.equal(parseSaleReceipt({ ...receipt, sale_id: '12345678-1234-4234-8234-123456789abd' }, valid.id), null);
  assert.equal(parseSaleReceipt({ ...receipt, changes: [] }, valid.id), null);
  assert.equal(parseSaleReceipt({ ...receipt, changes: [{ ingredient_id: '1' }] }, valid.id), null);
});
