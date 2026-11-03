import { tool } from "ai";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";
import { idValue, nonnegativeNumber, textValue } from "./shared";

const wastageInput = z.object({
  ingredientId: z.string().regex(/^\d+$/).max(30),
  amount: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => Math.round(value * 1_000_000) / 1_000_000 === value),
  reason: z.string().trim().min(1).max(200),
}).strict();

export const logWastageTool = tool({
  description: "Record owner-reported wasted or perished stock using the guarded inventory movement function. It appends a waste movement and adjusts stock; it never overwrites an inventory row directly.",
  inputSchema: wastageInput,
  execute: async (input) => withAgentActivity("log_wastage", input, async (activityId) => {
    const db = inventoryClient();
    const { data: row, error: readError } = await db
      .from("inventory")
      .select("last_updated")
      .eq("ingredient_id", input.ingredientId)
      .maybeSingle();
    if (readError) {
      console.error("Could not read inventory before recording wastage:", readError.message);
      throw new Error("Inventory could not be verified before recording wastage.");
    }
    if (!row || typeof row.last_updated !== "string" || !Number.isFinite(Date.parse(row.last_updated))) {
      throw new Error("A valid stock record is required before recording wastage.");
    }

    const { data, error } = await db.rpc("record_agent_inventory_movement", {
      p_activity_id: activityId,
      p_ingredient_id: input.ingredientId,
      p_kind: "waste",
      p_amount: input.amount,
      p_expected_updated: row.last_updated,
      p_note: input.reason,
    });
    if (error) {
      console.error("Could not record wastage:", error.message);
      throw new Error(error.message.includes("INSUFFICIENT_STOCK")
        ? "The wasted quantity exceeds stock on hand."
        : "Wastage could not be recorded. Check the inventory movement SQL setup.");
    }
    const quantityAfter = nonnegativeNumber(data, "Updated inventory quantity");
    return {
      status: "recorded" as const,
      ingredientId: idValue(input.ingredientId, "Ingredient ID"),
      quantityAfter,
      reason: textValue(input.reason, "Wastage reason"),
    };
  }),
});
