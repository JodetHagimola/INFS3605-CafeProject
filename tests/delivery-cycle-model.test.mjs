import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deliveryFollowupAction,
  deliveryWindowState,
  deterministicDeliveryId,
  quantityDifference,
  shortageExceedsPercent,
  sydneyDate,
  simulateArrivalOutcome,
  simulatedReceivedQuantity,
  withinDeliveryTolerance,
} from '../lib/automation/delivery-cycle-model.ts';

test('delivery windows use the Sydney calendar and local clock across daylight-saving changes', () => {
  assert.equal(sydneyDate(new Date('2026-11-15T00:00:00.000Z')), '2026-11-15');
  assert.equal(sydneyDate(new Date('2026-06-01T14:30:00.000Z')), '2026-06-02');
  assert.equal(deliveryWindowState(new Date('2026-11-14T22:59:00.000Z'), '2026-11-15', '10:00', '12:00'), 'before');
  assert.equal(deliveryWindowState(new Date('2026-11-15T00:00:00.000Z'), '2026-11-15', '10:00', '12:00'), 'open');
  assert.equal(deliveryWindowState(new Date('2026-11-15T01:01:00.000Z'), '2026-11-15', '10:00', '12:00'), 'passed');
  assert.equal(deliveryWindowState(new Date('2026-11-15T00:00:00.000Z'), '2026-11-16', '10:00', '12:00'), 'not_due');
  assert.equal(deliveryWindowState(new Date('2026-11-15T00:00:00.000Z'), '2026-11-15', null, null), 'missing_window');
  assert.throws(() => deliveryWindowState(new Date('2026-11-15T00:00:00.000Z'), '2026-11-15', '13:00', '12:00'));
});

test('arrival simulation is deterministic and approximates the configured 90/7/3 split', () => {
  const eventId = deterministicDeliveryId('arrival', '73', '2026-11-15');
  assert.match(eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(eventId, deterministicDeliveryId('arrival', '73', '2026-11-15'));
  assert.notEqual(eventId, deterministicDeliveryId('arrival', '73', '2026-11-16'));
  const counts = { complete: 0, short: 0, late: 0 };
  for (let id = 1; id <= 10_000; id += 1) {
    const outcome = simulateArrivalOutcome(String(id), '2026-11-15');
    counts[outcome.kind] += 1;
    assert.deepEqual(outcome, simulateArrivalOutcome(String(id), '2026-11-15'));
  }
  assert.ok(counts.complete >= 8_800 && counts.complete <= 9_200);
  assert.ok(counts.short >= 600 && counts.short <= 800);
  assert.ok(counts.late >= 200 && counts.late <= 400);
});

test('simulated partial quantities stay within six decimal places and never exceed the expected balance', () => {
  assert.equal(simulatedReceivedQuantity('1000', 25), '750');
  assert.equal(simulatedReceivedQuantity('1.234567', 20), '0.987653');
  assert.equal(simulatedReceivedQuantity('0.000001', 20), null);
  assert.equal(withinDeliveryTolerance('100', '97'), true);
  assert.equal(withinDeliveryTolerance('100', '96.999999'), false);
  assert.equal(withinDeliveryTolerance('100', '103'), true);
  assert.equal(withinDeliveryTolerance('100', '103.000001'), false);
  assert.equal(quantityDifference('100', '72.5'), '27.5');
  assert.equal(quantityDifference('10', '12'), '0');
  assert.equal(shortageExceedsPercent('100', '75', 25), false);
  assert.equal(shortageExceedsPercent('100', '74.999999', 25), true);
});

test('overdue followups chase twice 24 hours apart, then request a decision and lapse at day seven', () => {
  const firstChase = new Date('2026-11-03T00:00:00.000Z');
  const secondChase = new Date('2026-11-04T00:00:00.000Z');
  const decision = new Date('2026-11-05T00:00:00.000Z');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-02', 0, null, firstChase), 'none');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-03', 0, null, firstChase), 'chase');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-04', 1, '2026-11-03T00:00:01.000Z', secondChase), 'none');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-04', 1, '2026-11-03T00:00:00.000Z', secondChase), 'chase');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-05', 2, '2026-11-04T00:00:01.000Z', decision), 'none');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-05', 2, '2026-11-04T00:00:00.000Z', decision), 'decision');
  assert.equal(deliveryFollowupAction('2026-11-02', '2026-11-09', 0, null, decision), 'lapse');
});
