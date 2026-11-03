import { tool } from "ai";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";
import { idValue, nonnegativeNumber, textValue } from "./shared";

const deliveryInput = z.object({
  deliveryId: z.string().regex(/^\d+$/).max(30),
  receivedQuantity: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => Math.round(value * 1_000_000) / 1_000_000 === value),
  note: z.string().trim().max(200).default("Owner-reported delivery"),
}).strict();

export const recordDeliveryTool = tool({
  description: "Append an owner-reported delivery receipt and update shared inventory through the database's atomic delivery function. Never edit the original order or mark it sent.",
  inputSchema: deliveryInput,
  execute: async (input) => withAgentActivity("record_delivery", input, async (activityId) => {
    const db = inventoryClient();
    const { data: delivery, error: deliveryError } = await db
      .from("incoming_deliveries")
      .select("delivery_id,ingredient_id,quantity")
      .eq("delivery_id", input.deliveryId)
      .maybeSingle();
    if (deliveryError) {
      console.error("Could not verify an incoming delivery:", deliveryError.message);
      throw new Error("The incoming delivery could not be verified.");
    }
    if (!delivery) throw new Error("No matching incoming delivery exists.");

    const { data: stock, error: stockError } = await db
      .from("inventory")
      .select("last_updated")
      .eq("ingredient_id", String(delivery.ingredient_id))
      .maybeSingle();
    if (stockError) {
      console.error("Could not read inventory before receiving a delivery:", stockError.message);
      throw new Error("Inventory could not be verified before recording the delivery.");
    }
    if (!stock || typeof stock.last_updated !== "string" || !Number.isFinite(Date.parse(stock.last_updated))) {
      throw new Error("A valid stock record is required before recording the delivery.");
    }

    const { data, error } = await db.rpc("record_agent_delivery_receipt", {
      p_activity_id: activityId,
      p_delivery_id: input.deliveryId,
      p_received_quantity: input.receivedQuantity,
      p_expected_updated: stock.last_updated,
      p_note: input.note,
    });
    if (error) {
      console.error("Could not record a delivery receipt:", error.message);
      throw new Error("The delivery receipt could not be recorded. Check the agent write SQL setup.");
    }

    const { data: receipts, error: receiptError } = await db
      .from("delivery_receipts")
      .select("received_quantity")
      .eq("delivery_id", input.deliveryId);
    if (receiptError) {
      console.error("Could not verify a saved delivery receipt:", receiptError.message);
      throw new Error("The delivery was recorded but its receipt status could not be verified.");
    }
    const received = (receipts ?? []).reduce(
      (sum, receipt) => sum + nonnegativeNumber(receipt.received_quantity, "Received quantity"),
      0,
    );
    const ordered = nonnegativeNumber(delivery.quantity, "Ordered delivery quantity");
    return {
      status: "recorded" as const,
      deliveryId: idValue(delivery.delivery_id, "Delivery ID"),
      ingredientId: idValue(delivery.ingredient_id, "Ingredient ID"),
      orderedQuantity: ordered,
      receivedQuantity: received,
      inventoryQuantityAfter: nonnegativeNumber(data, "Updated inventory quantity"),
      discrepancy: received !== ordered,
      note: textValue(input.note, "Delivery note"),
    };
  }),
});
