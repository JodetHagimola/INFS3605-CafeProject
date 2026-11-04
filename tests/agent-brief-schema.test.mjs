import assert from "node:assert/strict";
import test from "node:test";
import {
  dailyBriefOutputSchema,
  normalizeDailyBriefOutput,
} from "../lib/agent/brief-schema.ts";

function briefOutput() {
  return {
    greeting: "Good morning.",
    statusLine: "Two things need attention.",
    items: [{
      title: "Review the delivery",
      why: "It is overdue.",
      actionTaken: "No action taken.",
      primaryAction: { label: "Approve", approvalId: "11111111-1111-4111-8111-111111111111" },
      secondaryAction: null,
    }],
    allClear: "Review the flagged delivery.",
    details: {
      lowStock: [{
        ingredientId: "1",
        ingredient: "Milk",
        quantity: null,
        unit: "ml",
        status: "No stock record",
      }],
      forecasts: [],
      deliveries: [{
        deliveryId: "2",
        ingredient: "Milk",
        orderedQuantity: 100,
        receivedQuantity: 50,
        expectedDate: "2026-11-04",
        status: "partial",
        flag: "Delivery is overdue.",
      }],
      supplierComparison: [],
      assumptions: [],
      dataWarnings: [],
    },
  };
}

test("brief output schema requires the expected object shape", () => {
  assert.equal(dailyBriefOutputSchema.safeParse(briefOutput()).success, true);
  assert.equal(dailyBriefOutputSchema.safeParse([{ title: "Wrong top-level shape" }]).success, false);
});

test("brief normalization assigns IDs and removes unverified approval references", () => {
  const parsed = dailyBriefOutputSchema.parse(briefOutput());
  const result = normalizeDailyBriefOutput(parsed, new Set(), new Set());

  assert.equal(result.items[0].id, "brief-item-1");
  assert.deepEqual(result.items[0].primaryAction, { label: "Edit" });
  assert.equal("secondaryAction" in result.items[0], false);
  assert.equal(result.details.lowStock[0].quantity, null);
});

test("brief normalization preserves verified approval IDs and reflects standing-rule approvals", () => {
  const parsed = dailyBriefOutputSchema.parse(briefOutput());
  const result = normalizeDailyBriefOutput(
    parsed,
    new Set(["11111111-1111-4111-8111-111111111111"]),
    new Set(["11111111-1111-4111-8111-111111111111"]),
  );

  assert.deepEqual(result.items[0].primaryAction, {
    label: "Confirm",
    approvalId: "11111111-1111-4111-8111-111111111111",
  });
});
