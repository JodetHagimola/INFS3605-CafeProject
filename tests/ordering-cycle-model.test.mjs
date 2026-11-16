import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateOrderingPlan } from '../lib/automation/ordering-cycle-model.ts';

const base = {
  today: '2026-11-15',
  stock: '10',
  minimum: '20',
  averageDailyUsage: '3',
  incoming: [{ quantity: '3', expectedDate: '2026-11-16' }],
  quotes: [{
    supplier: 'Local supplier',
    price: '0.123456',
    minimumOrder: '15',
    packSize: '10',
    packLabel: '10 kg sack',
    leadTimeDays: 2,
    active: true,
    contactEmail: 'orders@example.test',
  }],
  rule: { supplier: 'Local supplier', packs: 1, orderLimit: '10', enabled: true },
  autoOrderLimit: '10',
  dailyLimit: '20',
  weeklyLimit: '100',
  committedToday: '0',
  committedThisWeek: '0',
};

test('orders whole packs to cover projected stock and rounds price to cents', () => {
  const result = calculateOrderingPlan(base);
  assert.equal(result.status, 'order');
  assert.equal(result.candidate.packs, 2);
  assert.equal(result.candidate.stockAmount, '20');
  assert.equal(result.candidate.expectedDate, '2026-11-17');
  assert.equal(result.candidate.totalCents, 247);
  assert.equal(result.candidate.minimumOrder, '15');
  assert.equal(result.candidate.autoEligible, true);
});

test('uses the preferred supplier, otherwise chooses the cheapest whole-pack quote', () => {
  const preferred = calculateOrderingPlan({
    ...base,
    quotes: [
      base.quotes[0],
      { ...base.quotes[0], supplier: 'Cheaper supplier', price: '0.01' },
    ],
  });
  assert.equal(preferred.status, 'order');
  assert.equal(preferred.candidate.supplier, 'Local supplier');

  const cheapest = calculateOrderingPlan({
    ...base,
    stock: '1',
    minimum: '20',
    averageDailyUsage: '1',
    quotes: [
      { ...base.quotes[0], supplier: 'Slow supplier', price: '0.01', leadTimeDays: 2 },
      { ...base.quotes[0], supplier: 'Fast supplier', price: '0.001', leadTimeDays: 1 },
    ],
    rule: null,
  });
  assert.equal(cheapest.status, 'order');
  assert.equal(cheapest.candidate.supplier, 'Fast supplier');
});

test('rounds the supplier minimum up to a whole number of packs', () => {
  const result = calculateOrderingPlan({
    ...base,
    stock: '19',
    minimum: '20',
    averageDailyUsage: '0.1',
    incoming: [],
    quotes: [{ ...base.quotes[0], minimumOrder: '15' }],
    rule: null,
  });
  assert.equal(result.status, 'order');
  assert.equal(result.candidate.packs, 2);
  assert.equal(result.candidate.stockAmount, '20');
});

test('does not order when incoming stock keeps projection above the minimum', () => {
  const result = calculateOrderingPlan({
    ...base,
    incoming: [{ quantity: '20', expectedDate: '2026-11-16' }],
  });
  assert.deepEqual(result, {
    status: 'no_action',
    reason: 'Projected stock stays above the minimum before eligible supplier arrivals.',
  });
});

test('requires owner approval if supplier contact or a spending policy check is missing', () => {
  const noContact = calculateOrderingPlan({
    ...base,
    quotes: [{ ...base.quotes[0], contactEmail: null }],
  });
  assert.equal(noContact.status, 'order');
  assert.equal(noContact.candidate.autoEligible, false);
  assert.ok(noContact.candidate.flags.includes('Supplier contact details are missing.'));

  const overBudget = calculateOrderingPlan({ ...base, committedThisWeek: '99' });
  assert.equal(overBudget.status, 'order');
  assert.equal(overBudget.candidate.autoEligible, false);
  assert.ok(overBudget.candidate.flags.includes('Order would exceed the weekly spending limit.'));
});

test('stops rather than guessing when stock, thresholds, or prices are unavailable', () => {
  assert.equal(calculateOrderingPlan({ ...base, minimum: null }).status, 'blocked');
  assert.equal(calculateOrderingPlan({ ...base, quotes: [] }).status, 'blocked');
});
