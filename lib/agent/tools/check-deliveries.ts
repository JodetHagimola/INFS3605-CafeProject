import "server-only";

import { tool } from "ai";
import { z } from "zod";
import { idValue, nonnegativeNumber, readAll, textValue, validDate } from "./shared";
import { withAgentActivity } from "./activity";

export async function getDeliveryChecks() {
  const [ingredientRows, deliveryRows, receiptRows] = await Promise.all([
    readAll("ingredients", "ingredient_id,ingredient_name,unit"),
    readAll("incoming_deliveries", "delivery_id,ingredient_id,quantity,expected_date"),
    readAll("delivery_receipts", "delivery_id,received_quantity,received_at"),
  ]);
  const ingredientById = new Map(ingredientRows.map((row) => [
    idValue(row.ingredient_id, "Ingredient ID"),
    { name: textValue(row.ingredient_name, "Ingredient name"), unit: textValue(row.unit, "Ingredient unit") },
  ]));
  const receiptsByDelivery = new Map<string, { quantity: number; latestReceivedAt: string | null }>();
  for (const row of receiptRows) {
    const deliveryId = idValue(row.delivery_id, "Receipt delivery ID");
    const current = receiptsByDelivery.get(deliveryId) ?? { quantity: 0, latestReceivedAt: null };
    const receivedAt = row.received_at == null ? null : textValue(row.received_at, "Receipt timestamp");
    receiptsByDelivery.set(deliveryId, {
      quantity: current.quantity + nonnegativeNumber(row.received_quantity, "Received quantity"),
      latestReceivedAt: receivedAt && (!current.latestReceivedAt || receivedAt > current.latestReceivedAt)
        ? receivedAt
        : current.latestReceivedAt,
    });
  }
  const today = new Date().toISOString().slice(0, 10);
  return deliveryRows.map((row) => {
    const deliveryId = idValue(row.delivery_id, "Delivery ID");
    const ingredientId = idValue(row.ingredient_id, "Delivery ingredient ID");
    const expectedDate = validDate(row.expected_date, "Delivery expected date");
    const orderedQuantity = nonnegativeNumber(row.quantity, "Ordered delivery quantity");
    const received = receiptsByDelivery.get(deliveryId);
    const receivedQuantity = received?.quantity ?? 0;
    const remainingQuantity = Math.max(0, orderedQuantity - receivedQuantity);
    const overdue = expectedDate < today && remainingQuantity > 0;
    const status = receivedQuantity > orderedQuantity
      ? "over-delivered"
      : receivedQuantity === orderedQuantity
        ? "complete"
        : receivedQuantity > 0
          ? "partial"
          : overdue ? "overdue" : "awaiting";
    const ingredient = ingredientById.get(ingredientId);
    return {
      deliveryId,
      ingredientId,
      ingredient: ingredient?.name ?? "Unknown ingredient",
      unit: ingredient?.unit ?? null,
      orderedQuantity,
      receivedQuantity,
      remainingQuantity,
      expectedDate,
      latestReceivedAt: received?.latestReceivedAt ?? null,
      status,
      flag: !ingredient ? "Ingredient is missing from the ingredients table."
        : overdue ? "Delivery is overdue."
          : receivedQuantity > orderedQuantity
            ? "Received more than the ordered quantity."
            : receivedQuantity !== orderedQuantity && receivedQuantity > 0
              ? "Delivered quantity differs from the ordered quantity."
              : null,
    };
  });
}

export const checkDeliveriesTool = tool({
  description: "Compare incoming ordered quantities with appended delivery receipts and flag partial, over, or overdue deliveries.",
  inputSchema: z.object({}).strict(),
  execute: async (input) => withAgentActivity("check_deliveries", input, getDeliveryChecks),
});
