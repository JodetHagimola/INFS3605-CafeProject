import { tool } from "ai";
import { z } from "zod";
import { idValue, nonnegativeNumber, readAll, textValue } from "./shared";
import { withAgentActivity } from "./activity";

export const compareSupplierPricesTool = tool({
  description: "Read known supplier prices, delivery times, and minimum quantities for requested ingredients. Do not invent missing prices or suppliers.",
  inputSchema: z.object({
    ingredientIds: z.array(z.string().min(1).max(100)).min(1).max(100),
  }).strict(),
  execute: async (input) => withAgentActivity("compare_supplier_prices", input, async () => {
    const { ingredientIds } = input;
    const [ingredientRows, priceRows] = await Promise.all([
      readAll("ingredients", "ingredient_id,ingredient_name,unit"),
      readAll("supplier_prices", "supplier,ingredient_id,price,delivery_time,minimum_order"),
    ]);
    const ingredientById = new Map(ingredientRows.map((row) => [
      idValue(row.ingredient_id, "Ingredient ID"),
      { name: textValue(row.ingredient_name, "Ingredient name"), unit: textValue(row.unit, "Ingredient unit") },
    ]));
    const requested = [...new Set(ingredientIds)];
    return requested.map((ingredientId) => {
      const ingredient = ingredientById.get(ingredientId);
      const suppliers = priceRows
        .filter((row) => idValue(row.ingredient_id, "Supplier-price ingredient ID") === ingredientId)
        .map((row) => ({
          supplier: textValue(row.supplier, "Supplier name"),
          price: nonnegativeNumber(row.price, "Supplier price"),
          deliveryTime: textValue(row.delivery_time, "Supplier delivery time"),
          minimumOrder: nonnegativeNumber(row.minimum_order, "Supplier minimum order"),
        }))
        .sort((left, right) => left.price - right.price || left.deliveryTime.localeCompare(right.deliveryTime));
      return {
        ingredientId,
        ingredient: ingredient?.name ?? null,
        unit: ingredient?.unit ?? null,
        suppliers,
        flag: !ingredient
          ? "Ingredient is not listed."
          : suppliers.length
            ? "Supplier price freshness cannot be verified because update times are not stored."
            : "No supplier price is listed.",
      };
    });
  }),
});
