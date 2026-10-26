import test from 'node:test';
import assert from 'node:assert/strict';
import { stockStatus, numeric, movementAmount } from '../lib/inventory/model.ts';

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
