import test from 'node:test';
import assert from 'node:assert/strict';
import { isOrderRequestStatus, parseOrderRequestItems } from '../lib/order-requests/model.ts';

const values = (items) => items.map((item) => item ?? '');

test('parses valid order items and ignores entirely blank rows', () => {
  const result = parseOrderRequestItems(
    values(['Oat milk', '']),
    values(['6', '']),
    values(['cartons', '']),
  );
  assert.deepEqual(result, {
    items: [{ name: 'Oat milk', quantity: 6, unit: 'cartons' }],
    error: null,
  });
});

test('requires complete item rows and at least one item', () => {
  assert.match(parseOrderRequestItems(values(['Flour']), values(['']), values(['kg'])).error, /Complete all fields/);
  assert.match(parseOrderRequestItems(values(['']), values(['']), values([''])).error, /at least one item/);
});

test('rejects invalid quantities, excessive precision, and too many rows', () => {
  for (const quantity of ['0', '-1', 'abc', '1.0001', '1000001']) {
    assert.match(parseOrderRequestItems(values(['Coffee']), values([quantity]), values(['kg'])).error, /quantity/i);
  }
  assert.match(parseOrderRequestItems(
    Array(21).fill('item'),
    Array(21).fill('1'),
    Array(21).fill('unit'),
  ).error, /up to 20/);
});

test('recognizes only known order request statuses', () => {
  assert.equal(isOrderRequestStatus('pending'), true);
  assert.equal(isOrderRequestStatus('approved'), true);
  assert.equal(isOrderRequestStatus('rejected'), true);
  assert.equal(isOrderRequestStatus('cancelled'), false);
});
