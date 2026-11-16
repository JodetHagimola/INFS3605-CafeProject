import { tool } from "ai";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";
import { idValue, nonnegativeNumber, textValue } from "./shared";
import { convertStockQuantity } from "./units";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";

const deliveryInput = z.object({
  deliveryId: z.string().regex(/^\d+$/).max(30).optional(),
  ingredientName: z.string().trim().min(1).max(120).optional(),
  receivedQuantity: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => Math.round(value * 1_000_000) / 1_000_000 === value),
  receivedUnit: z.string().trim().min(1).max(40),
  note: z.string().trim().max(200).default("Owner-reported delivery"),
}).strict().refine((input) => Boolean(input.deliveryId || input.ingredientName), {
  message: "Provide an incoming delivery ID or an exact ingredient name.",
});

export const recordDeliveryTool = tool({
  description: "Record an owner-reported delivery. Match an incoming delivery by ID when available, otherwise match the exact ingredient name. Convert the reported unit to the inventory unit in TypeScript, append the movement, and update inventory atomically. Never edit an order or mark it sent.",
  inputSchema: deliveryInput,
  execute: async (input) => withAgentActivity("record_delivery", input, async (activityId) => {
    if (!inventoryWritesEnabled()) throw new Error("Stock changes are disabled by server policy.");
    const db = inventoryClient();
    let delivery: { delivery_id: number; ingredient_id: number; quantity: number } | null = null;
    let ingredient: { ingredient_id: number; ingredient_name: string; unit: string } | null = null;
    let deliveryId = input.deliveryId;

    if (input.deliveryId) {
      const { data, error } = await db
        .from("agent_delivery_status")
        .select("delivery_id,ingredient_id,quantity,closed_short")
        .eq("delivery_id", input.deliveryId)
        .maybeSingle();
      if (error) {
        console.error("Could not verify an incoming delivery:", error.message);
        throw new Error("The incoming delivery could not be verified.");
      }
      if (!data) throw new Error("No matching incoming delivery exists.");
      if (data.closed_short) throw new Error("This order was closed short. Review its supplier draft before recording a new delivery.");
      delivery = data;
      const { data: ingredientRow, error: ingredientError } = await db
        .from("ingredients")
        .select("ingredient_id,ingredient_name,unit")
        .eq("ingredient_id", String(data.ingredient_id))
        .maybeSingle();
      if (ingredientError || !ingredientRow) {
        console.error("Could not verify the delivery ingredient:", ingredientError?.message ?? "No ingredient found");
        throw new Error("The delivery ingredient could not be verified.");
      }
      ingredient = ingredientRow;
      if (input.ingredientName && input.ingredientName.toLowerCase() !== ingredient.ingredient_name.toLowerCase()) {
        throw new Error("The delivery ID does not match the reported ingredient.");
      }
    } else {
      const ingredientName = input.ingredientName;
      if (!ingredientName) throw new Error("An ingredient name is required for an unplanned delivery.");
      const { data, error } = await db
        .from("ingredients")
        .select("ingredient_id,ingredient_name,unit");
      if (error) {
        console.error("Could not find the reported delivery ingredient:", error.message);
        throw new Error("The reported ingredient could not be verified.");
      }
      const matches = (data ?? []).filter((row) =>
        row.ingredient_name.toLowerCase() === ingredientName.toLowerCase());
      if (matches.length !== 1) {
        throw new Error(matches.length ? "More than one ingredient matches that name." : "No ingredient matches that name.");
      }
      ingredient = matches[0];
    }

    if (!ingredient) throw new Error("The delivery ingredient could not be verified.");
    if (!deliveryId) {
      const { data: candidates, error: candidateError } = await db
        .from("agent_delivery_status")
        .select("delivery_id,ingredient_id,quantity,closed_short")
        .eq("ingredient_id", String(ingredient.ingredient_id));
      if (candidateError) {
        console.error("Could not check for a matching incoming delivery:", candidateError.message);
        throw new Error("Existing deliveries could not be checked before recording the receipt.");
      }
      if ((candidates ?? []).length > 0) {
        const candidateIds = (candidates ?? []).map((candidate) => String(candidate.delivery_id));
        const { data: priorReceipts, error: priorReceiptError } = await db
          .from("delivery_receipts")
          .select("delivery_id,received_quantity")
          .in("delivery_id", candidateIds);
        if (priorReceiptError) {
          console.error("Could not check prior delivery receipts:", priorReceiptError.message);
          throw new Error("Existing delivery receipts could not be checked before recording the receipt.");
        }
        const receivedByDelivery = new Map<string, number>();
        for (const receipt of priorReceipts ?? []) {
          const id = String(receipt.delivery_id);
          receivedByDelivery.set(
            id,
            (receivedByDelivery.get(id) ?? 0)
              + nonnegativeNumber(receipt.received_quantity, "Received quantity"),
          );
        }
        const outstanding = (candidates ?? []).filter((candidate) => !candidate.closed_short &&
          (receivedByDelivery.get(String(candidate.delivery_id)) ?? 0)
            < nonnegativeNumber(candidate.quantity, "Ordered delivery quantity"));
        if (!outstanding.length && candidates?.some(candidate => candidate.closed_short)) {
          throw new Error("An earlier order was closed short. Confirm a new order ID, or record a separate unplanned arrival on Inventory.");
        }
        if (outstanding.length > 1) {
          throw new Error("More than one incoming delivery matches this ingredient. Specify the delivery ID before recording it.");
        }
        if (outstanding.length === 1) {
          delivery = outstanding[0];
          deliveryId = String(delivery.delivery_id);
        }
      }
    }

    const stockUnit = textValue(ingredient.unit, "Ingredient unit");
    const stockQuantity = convertStockQuantity(input.receivedQuantity, input.receivedUnit, stockUnit);
    const { data: stock, error: stockError } = await db
      .from("inventory")
      .select("last_updated")
      .eq("ingredient_id", String(ingredient.ingredient_id))
      .maybeSingle();
    if (stockError) {
      console.error("Could not read inventory before receiving a delivery:", stockError.message);
      throw new Error("Inventory could not be verified before recording the delivery.");
    }
    if (!stock || typeof stock.last_updated !== "string" || !Number.isFinite(Date.parse(stock.last_updated))) {
      throw new Error("A valid stock record is required before recording the delivery.");
    }

    const { data, error } = delivery
      ? await db.rpc("record_agent_delivery_receipt", {
        p_activity_id: activityId,
        p_delivery_id: deliveryId,
        p_received_quantity: stockQuantity,
        p_expected_updated: stock.last_updated,
        p_note: input.note,
      })
      : await db.rpc("record_agent_inventory_movement", {
        p_activity_id: activityId,
        p_ingredient_id: ingredient.ingredient_id,
        p_kind: "delivery",
        p_amount: stockQuantity,
        p_expected_updated: stock.last_updated,
        p_note: input.note,
      });
    if (error) {
      console.error("Could not record a delivery:", error.message);
      throw new Error("The delivery could not be recorded. Check the agent write SQL setup.");
    }

    if (!delivery) {
      return {
        status: "recorded" as const,
        deliveryId: null,
        ingredientId: idValue(ingredient.ingredient_id, "Ingredient ID"),
        orderedQuantity: null,
        receivedQuantity: stockQuantity,
        inventoryQuantityAfter: nonnegativeNumber(data, "Updated inventory quantity"),
        discrepancy: false,
        note: textValue(input.note, "Delivery note"),
      };
    }

    const { data: receipts, error: receiptError } = await db
      .from("delivery_receipts")
      .select("received_quantity")
      .eq("delivery_id", deliveryId);
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
      ingredientId: idValue(ingredient.ingredient_id, "Ingredient ID"),
      orderedQuantity: ordered,
      receivedQuantity: received,
      inventoryQuantityAfter: nonnegativeNumber(data, "Updated inventory quantity"),
      discrepancy: received !== ordered,
      note: textValue(input.note, "Delivery note"),
    };
  }),
});
