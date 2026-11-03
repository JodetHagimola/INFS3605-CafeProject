import { tool } from "ai";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";
import { idValue, nonnegativeNumber, textValue } from "./shared";
import { convertStockQuantity } from "./units";

const wastageInput = z.object({
  ingredientId: z.string().regex(/^\d+$/).max(30).optional(),
  ingredientName: z.string().trim().min(1).max(120).optional(),
  amount: z.number().finite().positive().max(1_000_000_000)
    .refine((value) => Math.round(value * 1_000_000) / 1_000_000 === value),
  unit: z.string().trim().min(1).max(40),
  reason: z.string().trim().min(1).max(200).default("Owner-reported wastage"),
}).strict().refine((input) => Boolean(input.ingredientId || input.ingredientName), {
  message: "Provide an ingredient ID or an exact ingredient name.",
});

export const logWastageTool = tool({
  description: "Record owner-reported wasted or perished stock. Match an exact ingredient name or ID, convert the reported unit in TypeScript, then append a waste movement through the guarded inventory function. Never edit inventory directly.",
  inputSchema: wastageInput,
  execute: async (input) => withAgentActivity("log_wastage", input, async (activityId) => {
    const db = inventoryClient();
    let ingredient: { ingredient_id: number; ingredient_name: string; unit: string } | null = null;
    if (input.ingredientId) {
      const { data, error } = await db
        .from("ingredients")
        .select("ingredient_id,ingredient_name,unit")
        .eq("ingredient_id", input.ingredientId)
        .maybeSingle();
      if (error || !data) {
        console.error("Could not verify the wasted ingredient:", error?.message ?? "No ingredient found");
        throw new Error("The wasted ingredient could not be verified.");
      }
      ingredient = data;
      if (input.ingredientName && input.ingredientName.toLowerCase() !== data.ingredient_name.toLowerCase()) {
        throw new Error("The ingredient ID does not match the reported ingredient.");
      }
    } else {
      const ingredientName = input.ingredientName;
      if (!ingredientName) throw new Error("An ingredient name is required to record wastage.");
      const { data, error } = await db
        .from("ingredients")
        .select("ingredient_id,ingredient_name,unit");
      if (error) {
        console.error("Could not find the wasted ingredient:", error.message);
        throw new Error("The wasted ingredient could not be verified.");
      }
      const matches = (data ?? []).filter((row) =>
        row.ingredient_name.toLowerCase() === ingredientName.toLowerCase());
      if (matches.length !== 1) {
        throw new Error(matches.length ? "More than one ingredient matches that name." : "No ingredient matches that name.");
      }
      ingredient = matches[0];
    }

    if (!ingredient) throw new Error("The wasted ingredient could not be verified.");
    const stockUnit = textValue(ingredient.unit, "Ingredient unit");
    const amount = convertStockQuantity(input.amount, input.unit, stockUnit);
    const { data: row, error: readError } = await db
      .from("inventory")
      .select("last_updated")
      .eq("ingredient_id", String(ingredient.ingredient_id))
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
      p_ingredient_id: ingredient.ingredient_id,
      p_kind: "waste",
      p_amount: amount,
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
      ingredientId: idValue(ingredient.ingredient_id, "Ingredient ID"),
      ingredient: textValue(ingredient.ingredient_name, "Ingredient name"),
      amount,
      unit: stockUnit,
      quantityAfter,
      reason: textValue(input.reason, "Wastage reason"),
    };
  }),
});
