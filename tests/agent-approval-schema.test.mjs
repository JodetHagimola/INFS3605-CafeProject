import assert from "node:assert/strict";
import test from "node:test";
import {
  approvalActionSchema,
  approvalDetailsSchema,
} from "../lib/agent/approval-schema.ts";

test("restock approvals use the existing database action value", () => {
  assert.equal(approvalActionSchema.safeParse("place_or_send_order").success, true);
  assert.equal(approvalActionSchema.safeParse("place_order").success, false);
});

test("restock approval details stay within the inbox JSON contract", () => {
  const details = {
    briefDate: "2026-11-04",
    briefActionId: "c04dc417-83e7-4a46-8188-6aad3a5bb8b1",
    ingredientId: "1",
    ingredient: "Milk",
    quantity: 24,
    unit: "L",
    supplier: "Sunrise Dairy Co",
    estimatedCost: 37.2,
    reason: "Projected below minimum.",
    approvalSource: "today_brief",
  };
  assert.equal(approvalDetailsSchema.safeParse(details).success, true);
  assert.equal(approvalDetailsSchema.safeParse({ ...details, extra: "x".repeat(1001) }).success, false);
});
