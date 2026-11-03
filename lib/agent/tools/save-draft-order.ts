import { tool } from "ai";
import { z } from "zod";
import { draftOrderInsertSchema, draftOrderSchema, type DraftOrderRecord } from "@/lib/agent/draft-schema";
import { inventoryClient } from "@/lib/inventory/server";
import { calculateShortfalls } from "./calculate-shortfalls";
import { withAgentActivity } from "./activity";
import type { DemandForecast } from "./forecast-model";
import { idValue, nonnegativeNumber, readAll, textValue } from "./shared";

type SupplierPrice = {
  supplier: string;
  ingredientId: string;
  price: number;
  deliveryTime: string;
  minimumOrder: number;
};

function forecastRecord(forecast: DemandForecast) {
  const firstDay = forecast.dailyForecasts[0];
  return {
    forecastDate: forecast.startDate,
    endDate: forecast.endDate,
    isPublicHoliday: firstDay?.publicHoliday ?? null,
    predictedSales: Object.fromEntries(
      Object.entries(forecast.totals).map(([product, values]) => [product, values.expected]),
    ),
    ranges: forecast.totals,
    assumptions: forecast.assumptions,
    source: forecast.source,
  };
}

function deliveryFlags(
  deliveries: NonNullable<DraftOrderRecord["dataUsed"]>["deliveries"],
  receipts: NonNullable<DraftOrderRecord["dataUsed"]>["receipts"],
): string[] {
  const today = new Date().toISOString().slice(0, 10);
  const receivedByDelivery = new Map<string, number>();
  for (const receipt of receipts ?? []) {
    receivedByDelivery.set(
      receipt.deliveryId,
      (receivedByDelivery.get(receipt.deliveryId) ?? 0) + receipt.receivedQuantity,
    );
  }
  const flags = new Set<string>();
  for (const delivery of deliveries) {
    if (!delivery.deliveryId) continue;
    const received = receivedByDelivery.get(delivery.deliveryId) ?? 0;
    if (delivery.expectedDate < today && received < delivery.quantity) {
      flags.add(`Delivery ${delivery.deliveryId} is overdue.`);
    }
    if (received > 0 && received !== delivery.quantity) {
      flags.add(`Delivery ${delivery.deliveryId} has a quantity discrepancy.`);
    }
    if (received > delivery.quantity) {
      flags.add(`Delivery ${delivery.deliveryId} was over-delivered.`);
    }
  }
  return [...flags];
}

async function saveDraft(forecast: DemandForecast | null): Promise<
  | { status: "saved"; draft: DraftOrderRecord }
  | { status: "blocked"; draft: null; flags: string[] }
> {
  if (!forecast || forecast.status !== "ready") {
    return {
      status: "blocked",
      draft: null,
      flags: forecast?.flags.length ? forecast.flags : ["A complete demand forecast is required before saving a draft."],
    };
  }

  const shortfalls = await calculateShortfalls(forecast);
  if (shortfalls.status !== "ready" || !shortfalls.sourceData) {
    return { status: "blocked", draft: null, flags: shortfalls.flags };
  }

  const shortages = shortfalls.lines.filter((line) => line.shortfall > 0);
  const priceRows = shortages.length
    ? await readAll("supplier_prices", "supplier,ingredient_id,price,delivery_time,minimum_order")
    : [];
  const prices: SupplierPrice[] = priceRows.map((row) => ({
    supplier: textValue(row.supplier, "Supplier name"),
    ingredientId: idValue(row.ingredient_id, "Supplier-price ingredient ID"),
    price: nonnegativeNumber(row.price, "Supplier price"),
    deliveryTime: textValue(row.delivery_time, "Supplier delivery time"),
    minimumOrder: nonnegativeNumber(row.minimum_order, "Supplier minimum order"),
  }));
  const flags = [
    ...forecast.flags,
    ...shortfalls.flags,
    ...deliveryFlags(shortfalls.sourceData.deliveries, shortfalls.sourceData.receipts),
    "Supplier price update times are not stored, so price freshness cannot be verified.",
    "Expiry dates and historical usage reconciliation are not available; review perishables and stock discrepancies.",
  ];

  const lines: DraftOrderRecord["lines"] = [];
  for (const shortfall of shortages) {
    const available = prices
      .filter((price) => price.ingredientId === shortfall.ingredientId)
      .sort((left, right) => left.price - right.price || left.deliveryTime.localeCompare(right.deliveryTime));
    if (!available.length) {
      return {
        status: "blocked",
        draft: null,
        flags: [...flags, `No supplier price exists for ${shortfall.ingredient}; no draft was saved.`],
      };
    }

    const chosen = available[0];
    const recommendedOrderQuantity = Math.max(shortfall.shortfall, chosen.minimumOrder);
    if (recommendedOrderQuantity < 0 || recommendedOrderQuantity > shortfall.required * 2) {
      return {
        status: "blocked",
        draft: null,
        flags: [...flags, `The minimum or shortfall for ${shortfall.ingredient} exceeds twice its forecast requirement; no draft was saved.`],
      };
    }

    if (available.length === 1) flags.push(`${shortfall.ingredient} has only one listed supplier.`);
    lines.push({
      ingredientId: shortfall.ingredientId,
      ingredient: shortfall.ingredient,
      requiredQuantity: shortfall.required,
      requiredRange: shortfall.requiredRange,
      currentStock: shortfall.currentStock,
      incomingStock: shortfall.incomingStock,
      recommendedOrderQuantity,
      unit: shortfall.unit,
      recommendedSupplier: {
        supplier: chosen.supplier,
        price: chosen.price,
        deliveryTime: chosen.deliveryTime,
        minimumOrder: chosen.minimumOrder,
      },
      alternativeSupplier: available[1] ? {
        supplier: available[1].supplier,
        price: available[1].price,
        deliveryTime: available[1].deliveryTime,
        minimumOrder: available[1].minimumOrder,
      } : null,
      reason: `Forecast demand is ${shortfall.required} ${shortfall.unit}; ${shortfall.currentStock} in stock and ${shortfall.incomingStock} incoming leave a shortfall of ${shortfall.shortfall}. The suggested quantity respects the listed supplier minimum.`,
    });
  }

  const dataUsed: DraftOrderRecord["dataUsed"] = {
    recipes: shortfalls.sourceData.recipes,
    inventory: shortfalls.sourceData.inventory,
    deliveries: shortfalls.sourceData.deliveries,
    receipts: shortfalls.sourceData.receipts,
    supplierPrices: prices.filter((price) => shortages.some((line) => line.ingredientId === price.ingredientId)),
  };
  const candidate = draftOrderInsertSchema.safeParse({
    status: "draft",
    forecastDate: forecast.startDate,
    forecast: forecastRecord(forecast),
    lines,
    flags: [...new Set(flags)],
    dataUsed,
  });
  if (!candidate.success) {
    console.error("Generated draft failed schema validation:", candidate.error.issues.length);
    throw new Error("The generated draft did not pass validation and was not saved.");
  }

  const { data, error } = await inventoryClient()
    .from("draft_orders")
    .insert({
      status: candidate.data.status,
      forecast_date: candidate.data.forecastDate,
      forecast: candidate.data.forecast,
      lines: candidate.data.lines,
      flags: candidate.data.flags,
      data_used: candidate.data.dataUsed,
    })
    .select("id,status,forecast_date,created_at,forecast,lines,flags,data_used")
    .single();
  if (error || !data) {
    console.error("Could not save an automated ordering draft:", error?.message ?? "No row returned");
    throw new Error("The draft could not be saved. Check the draft_orders setup in Supabase.");
  }

  const saved = draftOrderSchema.safeParse({
    id: String(data.id),
    status: data.status,
    forecastDate: String(data.forecast_date),
    createdAt: String(data.created_at),
    forecast: data.forecast,
    lines: data.lines,
    flags: data.flags,
    dataUsed: data.data_used,
  });
  if (!saved.success) {
    console.error("Saved draft failed schema validation:", saved.error.issues.length);
    throw new Error("The saved draft did not pass validation.");
  }
  return { status: "saved", draft: saved.data };
}

export function createSaveDraftOrderTool(
  getForecast: () => DemandForecast | null,
  onSaved: (draft: DraftOrderRecord) => void,
  hasSaved: () => boolean,
) {
  return tool({
    description: "Save a draft only after the forecast and shortfalls are available. The tool computes all quantities and chooses only listed suppliers; it never approves or sends an order.",
    inputSchema: z.object({}).strict(),
    execute: async (input) => withAgentActivity("save_draft_order", input, async () => {
      if (hasSaved()) {
        return {
          status: "blocked" as const,
          draft: null,
          flags: ["A draft was already saved during this agent request."],
        };
      }
      const result = await saveDraft(getForecast());
      if (result.status === "saved") onSaved(result.draft);
      return result;
    }),
  });
}
