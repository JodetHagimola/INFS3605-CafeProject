import { sydneyDay } from "@/lib/inventory-sales/operations-model";
import { tool } from "ai";
import { z } from "zod";
import { getInventory } from "@/lib/inventory/server";
import type { InventoryItem } from "@/lib/inventory/model";
import { idValue, nonnegativeNumber, readAll, textValue, validDate } from "./shared";
import type { DemandForecast } from "./forecast-model";
import { withAgentActivity } from "./activity";
import { shortfallAmount } from "./shortfall-model";

export type ShortfallLine = {
  ingredientId: string;
  ingredient: string;
  unit: string;
  required: number;
  requiredRange: { low: number; high: number };
  currentStock: number;
  incomingStock: number;
  shortfall: number;
};

export type ShortfallResult = {
  status: "ready" | "blocked";
  endDate: string | null;
  flags: string[];
  lines: ShortfallLine[];
  sourceData?: {
    recipes: Array<{ productName: string; ingredientId: string; quantityPerDrink: number }>;
    inventory: Array<{ ingredientId: string; quantity: number | null; lastUpdated: string | null }>;
    deliveries: Array<{ deliveryId: string; ingredientId: string; quantity: number; expectedDate: string }>;
    receipts: Array<{ deliveryId: string; receivedQuantity: number; receivedAt: string }>;
  };
};

function isStale(item: InventoryItem | undefined, now: number): boolean {
  if (!item?.updated) return true;
  const updatedAt = Date.parse(item.updated);
  return !Number.isFinite(updatedAt)
    || updatedAt > now + 5 * 60 * 1000
    || now - updatedAt > 7 * 24 * 60 * 60 * 1000;
}

export async function calculateShortfalls(forecast: DemandForecast | null): Promise<ShortfallResult> {
  if (!forecast || forecast.status !== "ready") {
    return {
      status: "blocked",
      endDate: forecast?.endDate ?? null,
      flags: ["Run forecast_demand and confirm it has sufficient sales history before calculating shortfalls."],
      lines: [],
    };
  }

  const dailyForecasts = forecast.dailyForecasts;
  const dates = dailyForecasts.map((day) => validDate(day.date, "Forecast date"));
  const endDate = dates.reduce((latest, date) => date > latest ? date : latest, dates[0]);
  const [ingredientRows, recipeRows, deliveryRows, receiptRows, inventoryResult] = await Promise.all([
    readAll("ingredients", "ingredient_id,ingredient_name,unit"),
    readAll("recipes", "product_name,ingredient_id,quantity_required"),
    readAll("incoming_deliveries", "delivery_id,ingredient_id,quantity,expected_date"),
    readAll("delivery_receipts", "delivery_id,received_quantity,received_at"),
    getInventory(),
  ]);
  if (inventoryResult.error) throw new Error(inventoryResult.error);

  const ingredients = new Map(ingredientRows.map((row) => {
    const id = idValue(row.ingredient_id, "Ingredient ID");
    return [id, {
      id,
      name: textValue(row.ingredient_name, "Ingredient name"),
      unit: textValue(row.unit, "Ingredient unit"),
    }];
  }));
  const recipes = recipeRows.map((row) => {
    const product = textValue(row.product_name, "Recipe product name");
    const quantityPerDrink = nonnegativeNumber(row.quantity_required, "Recipe quantity");
    if (quantityPerDrink === 0) throw new Error(`Recipe quantity for ${product} must be positive.`);
    return {
      product,
      ingredientId: idValue(row.ingredient_id, "Recipe ingredient ID"),
      quantityPerDrink,
    };
  });
  const requiredById = new Map<string, { low: number; expected: number; high: number }>();
  const missingRecipeProducts = new Set<string>();

  for (const day of dailyForecasts) {
    for (const [product, forecastRow] of Object.entries(day.products)) {
      const productRecipes = recipes.filter((recipe) => recipe.product === product);
      if (!productRecipes.length) {
        missingRecipeProducts.add(product);
        continue;
      }
      for (const recipe of productRecipes) {
        const required = requiredById.get(recipe.ingredientId) ?? { low: 0, expected: 0, high: 0 };
        requiredById.set(recipe.ingredientId, {
          low: required.low + forecastRow.low * recipe.quantityPerDrink,
          expected: required.expected + forecastRow.expected * recipe.quantityPerDrink,
          high: required.high + forecastRow.high * recipe.quantityPerDrink,
        });
      }
    }
  }

  const inventory = new Map(inventoryResult.items.map((item) => [item.id, item]));
  const now = Date.now();
  const receivedByDelivery = new Map<string, number>();
  const receipts = receiptRows.map((row) => {
    const deliveryId = idValue(row.delivery_id, "Receipt delivery ID");
    const receivedQuantity = nonnegativeNumber(row.received_quantity, "Received quantity");
    const receivedAt = textValue(row.received_at, "Receipt timestamp");
    if (!Number.isFinite(Date.parse(receivedAt))) throw new Error("A delivery receipt has an invalid timestamp.");
    { // Current stock already includes every saved receipt.
      receivedByDelivery.set(deliveryId, (receivedByDelivery.get(deliveryId) ?? 0) + receivedQuantity);
    }
    return { deliveryId, receivedQuantity, receivedAt };
  });
  const deliveries = deliveryRows.map((row) => ({
    deliveryId: idValue(row.delivery_id, "Delivery ID"),
    ingredientId: idValue(row.ingredient_id, "Delivery ingredient ID"),
    quantity: nonnegativeNumber(row.quantity, "Ordered delivery quantity"),
    expectedDate: validDate(row.expected_date, "Delivery expected date"),
  }));
  const deliveriesByIngredient = new Map<string, number>();
  const today = sydneyDay(new Date().toISOString());
  const overdueDeliveryFlags = new Set<string>();
  for (const delivery of deliveries) {
    if (delivery.expectedDate < today) {
      if (delivery.quantity > (receivedByDelivery.get(delivery.deliveryId) ?? 0)) {
        overdueDeliveryFlags.add(`Delivery ${delivery.deliveryId} is overdue and was not counted as incoming stock.`);
      }
      continue;
    }
    if (delivery.expectedDate > endDate) continue;
    const remaining = Math.max(0, delivery.quantity - (receivedByDelivery.get(delivery.deliveryId) ?? 0));
    deliveriesByIngredient.set(
      delivery.ingredientId,
      (deliveriesByIngredient.get(delivery.ingredientId) ?? 0) + remaining,
    );
  }

  const missingInventory = [...requiredById.keys()].filter((id) => {
    const item = inventory.get(id);
    return !item || item.quantity === null || item.quantity < 0 || item.status === "Check data";
  });
  const staleInventory = [...requiredById.keys()].filter((id) => isStale(inventory.get(id), now));
  const unknownIngredients = [...requiredById.keys()].filter((id) => !ingredients.has(id));
  const blockingFlags = [
    ...(missingRecipeProducts.size
      ? [`No recipe is available for: ${[...missingRecipeProducts].join(", ")}.`]
      : []),
    ...(missingInventory.length
      ? [`Inventory data is missing or invalid for ingredient IDs: ${missingInventory.join(", ")}.`]
      : []),
    ...(staleInventory.length
      ? [`Inventory data is stale or has no update time for ingredient IDs: ${staleInventory.join(", ")}.`]
      : []),
    ...(unknownIngredients.length
      ? [`Recipes refer to unknown ingredient IDs: ${unknownIngredients.join(", ")}.`]
      : []),
  ];
  const sourceData: NonNullable<ShortfallResult["sourceData"]> = {
    recipes: recipes.map(({ product, ingredientId, quantityPerDrink }) => ({
      productName: product,
      ingredientId,
      quantityPerDrink,
    })),
    inventory: inventoryResult.items.map((item) => ({
      ingredientId: item.id,
      quantity: item.quantity,
      lastUpdated: item.updated,
    })),
    deliveries,
    receipts,
  };

  if (blockingFlags.length) {
    return { status: "blocked", endDate, flags: blockingFlags, lines: [], sourceData };
  }

  const lines = [...requiredById.entries()].flatMap(([ingredientId, required]) => {
    const ingredient = ingredients.get(ingredientId);
    const stock = inventory.get(ingredientId);
    if (!ingredient || !stock || stock.quantity === null) return [];
    const incomingStock = deliveriesByIngredient.get(ingredientId) ?? 0;
    return [{
      ingredientId,
      ingredient: ingredient.name,
      unit: ingredient.unit,
      required: required.expected,
      requiredRange: { low: required.low, high: required.high },
      currentStock: stock.quantity,
      incomingStock,
      shortfall: shortfallAmount(required.expected, stock.quantity, incomingStock),
    }];
  }).sort((left, right) => left.ingredient.localeCompare(right.ingredient));

  return {
    status: "ready",
    endDate,
    flags: [
      "Recipe quantities are assumed to use the ingredient's listed inventory unit; no unrecorded unit conversion was applied.",
      ...overdueDeliveryFlags,
    ],
    lines,
    sourceData,
  };
}

export function createCalculateShortfallsTool(getForecast: () => DemandForecast | null) {
  return tool({
    description: "Calculate ingredient requirements from the forecast_demand tool result and recipes, then subtract shared stock and incoming deliveries in code. Never return negative shortfalls.",
    inputSchema: z.object({}).strict(),
    execute: async (input) => withAgentActivity("calculate_shortfalls", input, async () => {
      const result = await calculateShortfalls(getForecast());
      const { sourceData: _sourceData, ...publicResult } = result;
      return publicResult;
    }),
  });
}
