import { describe, expect, it } from "vitest";
import { calculateOrderingPlan } from "../lib/automation/ordering-cycle-model";
import { withinDeliveryTolerance } from "../lib/automation/delivery-cycle-model";
import { isSydneyRushTime, nextQuietTime } from "../lib/owner-communication-model";
import { calculateAutomaticMinimum, isStockCountDue } from "../lib/inventory/automation-model";
import { inventoryWritesEnabled } from "../lib/inventory/write-policy";
import { hashPosPayload } from "../lib/inventory-sales/pos";

const orderInput = {
  today: "2026-11-15",
  stock: "10",
  minimum: "20",
  averageDailyUsage: "3",
  incoming: [{ quantity: "3", expectedDate: "2026-11-16" }],
  quotes: [{
    supplier: "Local supplier",
    price: "0.123456",
    minimumOrder: "15",
    packSize: "10",
    packLabel: "10 kg sack",
    leadTimeDays: 2,
    active: true,
    contactEmail: "orders@example.test",
  }],
  rule: { supplier: "Local supplier", packs: 1, orderLimit: "10", enabled: true },
  autoOrderLimit: "10",
  dailyLimit: "20",
  weeklyLimit: "100",
  committedToday: "0",
  committedThisWeek: "0",
};

describe("Workstream F policy and automation models", () => {
  it("calculates automatic stock thresholds and rejects unusable inputs", () => {
    expect(calculateAutomaticMinimum(3, 2)).toBe(10);
    expect(calculateAutomaticMinimum(0, 2)).toBeNull();
    expect(calculateAutomaticMinimum(3, 366)).toBeNull();
    expect(isStockCountDue(null, Date.parse("2026-11-15T00:00:00Z"))).toBe(true);
    expect(isStockCountDue("2026-11-14T00:00:00Z", Date.parse("2026-11-15T00:00:00Z"))).toBe(false);
  });

  it("requires an explicit opt-in for production writes", () => {
    expect(inventoryWritesEnabled("production", "true")).toBe(true);
    expect(inventoryWritesEnabled("production", "false")).toBe(false);
    expect(inventoryWritesEnabled("development", "false")).toBe(true);
  });

  it("keeps whole-pack reorder decisions inside or outside the auto-order policy", () => {
    const eligible = calculateOrderingPlan(orderInput);
    if (eligible.status !== "order") throw new Error("Expected an order plan.");
    expect(eligible.status).toBe("order");
    expect(eligible.candidate.packs).toBe(2);
    expect(eligible.candidate.autoEligible).toBe(true);

    const requiresApproval = calculateOrderingPlan({ ...orderInput, autoOrderLimit: "1" });
    if (requiresApproval.status !== "order") throw new Error("Expected an order plan requiring approval.");
    expect(requiresApproval.status).toBe("order");
    expect(requiresApproval.candidate.autoEligible).toBe(false);
    expect(requiresApproval.candidate.flags).toContain("Order total exceeds the automatic per-order limit.");
  });

  it("applies the delivery tolerance boundary exactly", () => {
    expect(withinDeliveryTolerance("100", "97")).toBe(true);
    expect(withinDeliveryTolerance("100", "96.999999")).toBe(false);
    expect(withinDeliveryTolerance("100", "103")).toBe(true);
    expect(withinDeliveryTolerance("100", "103.000001")).toBe(false);
  });

  it("defers rush-time decisions to the end of the Sydney quiet-window boundary", () => {
    const now = new Date("2026-01-15T00:30:00.000Z");
    const windows = [{ start: "11:00", end: "13:00" }];
    expect(isSydneyRushTime(now, windows)).toBe(true);
    expect(nextQuietTime(now, windows).toISOString()).toBe("2026-01-15T02:00:00.000Z");
  });

  it("generates stable idempotency hashes for identical webhook payloads", () => {
    const first = Buffer.from('{"external_ref":"sale-1","items":[{"product_name":"Flat white","quantity":2}]}');
    const same = Buffer.from('{"external_ref":"sale-1","items":[{"product_name":"Flat white","quantity":2}]}');
    const changed = Buffer.from('{"external_ref":"sale-1","items":[{"product_name":"Flat white","quantity":3}]}');
    expect(hashPosPayload(first)).toBe(hashPosPayload(same));
    expect(hashPosPayload(first)).not.toBe(hashPosPayload(changed));
  });
});
