import test from 'node:test';
import assert from 'node:assert/strict';
import { stockStatus, numeric, movementAmount, countedAmount } from '../lib/inventory/model.ts';
import { calculateAutomaticMinimum, isStockCountDue } from '../lib/inventory/automation-model.ts';

test('missing stock and thresholds are never classified as sufficient', () => {
  assert.equal(stockStatus(false, null, 5), 'No stock record');
  assert.equal(stockStatus(true, 12, null), 'Threshold not set');
  assert.equal(stockStatus(true, 0, null), 'Out of stock');
});
test('threshold boundary, zero and invalid stock are distinct', () => {
  assert.equal(stockStatus(true, 5, 5), 'Low stock');
  assert.equal(stockStatus(true, 5.1, 5), 'In stock');
  assert.equal(stockStatus(true, 0, 5), 'Out of stock');
  assert.equal(stockStatus(true, 1, 0), 'In stock');
  assert.equal(stockStatus(true, -1, 5), 'Check data');
  assert.equal(stockStatus(true, null, 5), 'Check data');
  assert.equal(stockStatus(true, 5, -1), 'Check data');
});
test('database numeric strings are normalized without converting missing data to zero', () => {
  assert.equal(numeric('0.25'), .25);
  for (const value of [null, undefined, '', ' ', 'NaN', 'Infinity', false, {}]) assert.equal(numeric(value), null);
});
test('movement inputs reject empty, negative, zero, nonfinite and excessive precision', () => {
  for (const value of ['', '0', '-3', 'abc', 'NaN', 'Infinity', '1e3', '0.0000001', '1000000001', null]) assert.equal(movementAmount(value), null);
  assert.equal(movementAmount('0.125'), .125);
  assert.equal(movementAmount(' 8 '), 8);
});
test('physical counts allow zero but reject malformed or out-of-range values', () => {
  assert.equal(countedAmount('0'), 0);
  assert.equal(countedAmount('12.125'), 12.125);
  for (const value of ['', '-1', '1e3', '0.0000001', '1000000001', 'NaN', null])
    assert.equal(countedAmount(value), null);
});
test('automatic minimum uses lead time, buffer, and ceiling without inventing unusable thresholds', () => {
  assert.equal(calculateAutomaticMinimum(10, 2), 33);
  assert.equal(calculateAutomaticMinimum(0.1, 0), 1);
  for (const [usage, lead] of [[0, 2], [-1, 2], [NaN, 2], [10, -1], [10, 1.5], [10, 366], [1e12, 10]])
    assert.equal(calculateAutomaticMinimum(usage, lead), null);
});
test('stock count confidence follows physical-count time, not ledger movement time', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');
  assert.equal(isStockCountDue(null, now), true);
  assert.equal(isStockCountDue('invalid', now), true);
  assert.equal(isStockCountDue('2026-11-08T11:59:59Z', now), true);
  assert.equal(isStockCountDue('2026-11-08T12:00:00Z', now), false);
  assert.equal(isStockCountDue('2026-11-15T11:00:00Z', now, true), true);
});
