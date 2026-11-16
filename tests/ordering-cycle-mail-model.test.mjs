import test from 'node:test';
import assert from 'node:assert/strict';
import { formatOrderLine, isSupplierAddress, testMailRecipient } from '../lib/automation/mail-model.ts';

test('formats pack quantities and stock-unit prices in human-sized units', () => {
  assert.equal(formatOrderLine({
    ingredient: 'Milk',
    unit: 'ml',
    packs: 2,
    packLabel: '12 x 1 L crate',
    quantity: '24000',
    unitPrice: '0.0048',
    expectedDate: '2026-11-17',
  }), 'Milk: 2 crates (24 L) at $4.80 per L; expected 2026-11-17.');

  assert.equal(formatOrderLine({
    ingredient: 'Coffee beans',
    unit: 'g',
    packs: 1,
    packLabel: '1 kg bag',
    quantity: '1000',
    unitPrice: '0.02',
    expectedDate: '2026-11-17',
  }), 'Coffee beans: 1 bag (1 kg) at $20.00 per kg; expected 2026-11-17.');
});

test('test email delivery only accepts the configured test mailbox', () => {
  assert.equal(testMailRecipient('resend', 'owner-demo@example.test'), 'owner-demo@example.test');
  assert.throws(() => testMailRecipient('resend', 'not-an-address'));
  assert.throws(() => testMailRecipient('resend'));
  assert.equal(testMailRecipient('inbox'), 'demo-inbox@example.invalid');
});

test('rejects a test mailbox that matches a supplier contact', () => {
  assert.equal(isSupplierAddress(' ORDERS@example.test ', [null, 'orders@EXAMPLE.test']), true);
  assert.equal(isSupplierAddress('test@example.test', ['orders@example.test']), false);
});
