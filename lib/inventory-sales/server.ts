import "server-only";

import { inventoryClient } from "@/lib/inventory/server";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import { parseSaleIntent, parseSaleReceipt, type SaleProduct, type SaleResult, type SaleSource } from "./model";

export async function persistSale(
  value: unknown,
  source: SaleSource,
  externalRef: string | null = null,
  occurredAt: string | null = null,
): Promise<SaleResult> {
  const intent = parseSaleIntent(value);
  if (!intent) return { status: "error", message: "Choose a drink and enter a whole number from 1 to 1000." };
  if (!inventoryWritesEnabled()) {
    return { status: "error", message: "Stock changes are disabled by server policy." };
  }
  try {
    const { data, error } = await inventoryClient().rpc("record_inventory_sale_with_source", {
      p_request_id: intent.id,
      p_product_name: intent.product,
      p_quantity: intent.quantity,
      p_source: source,
      p_external_ref: externalRef,
      p_occurred_at: occurredAt,
    });
    if (error) {
      const messages: Record<string, string> = {
        INVALID_SALE: "Choose a drink and enter a whole number from 1 to 1000.",
        INVALID_SALE_SOURCE: "The sale source or reference is invalid.",
        RECIPE_NOT_FOUND: "This drink no longer has a recipe. Refresh the page.",
        INVALID_RECIPE: "The recipe is invalid or duplicated. Ask the team to check it before recording this sale.",
        NO_STOCK_RECORD: "A required ingredient has no inventory record.",
        INVALID_STOCK: "An ingredient has an invalid stock quantity. Check inventory first.",
        INSUFFICIENT_STOCK: "Not enough stock for this sale. No ingredients were deducted.",
      };
      for (const [code, message] of Object.entries(messages)) {
        if (error.message.includes(code)) return { status: "error", message };
      }
      if (error.message.includes("SALE_REQUEST_CONFLICT") || error.message.includes("SALE_EXTERNAL_REF_CONFLICT"))
        return { status: "uncertain", message: "This sale reference conflicts with a previous entry. Check sales history before trying another reference." };
      return { status: "uncertain", message: "The sale could not be confirmed. Retry the same reference after checking sales history; do not enter it again as a new sale." };
    }
    const receipt = parseSaleReceipt(data, intent.id);
    if (!receipt) return { status: "uncertain", message: "The sale response could not be confirmed. Retry this same reference to check its saved result." };
    return {
      status: "success",
      receipt,
      message: receipt.replayed
        ? "This sale was already saved. No additional stock was deducted."
        : "Sale saved. Ingredient usage has been recorded.",
    };
  } catch {
    return { status: "uncertain", message: "The connection was interrupted. Retry the same reference to confirm the sale without deducting stock twice." };
  }
}

export async function getSaleProducts(): Promise<{ products: SaleProduct[]; error: string | null }> {
  try {
    const db = inventoryClient();
    async function read(table: string, columns: string, order: string) {
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += 500) {
        let query = db.from(table).select(columns).order(order);
        if (table === "recipes") query = query.order("ingredient_id");
        const { data, error } = await query.range(offset, offset + 499);
        if (error) throw error;
        rows.push(...data as unknown as Record<string, unknown>[]);
        if (data.length < 500) return rows;
      }
    }
    const [recipes, ingredients] = await Promise.all([
      read("recipes", "product_name,ingredient_id,quantity_required", "product_name"),
      read("ingredients", "ingredient_id,ingredient_name,unit", "ingredient_id"),
    ]);
    const ingredientMap = new Map(ingredients.map(i => [String(i.ingredient_id), i]));
    const products = new Map<string, SaleProduct>();
    const seen = new Set<string>();
    for (const r of recipes) {
      const product = r.product_name;
      const i = ingredientMap.get(String(r.ingredient_id));
      const amount = Number(r.quantity_required);
      const key = JSON.stringify([product, String(r.ingredient_id)]);
      if (typeof product !== "string" || !product.trim() || product.length > 120
        || !i || typeof i.ingredient_name !== "string" || !i.ingredient_name.trim()
        || typeof i.unit !== "string" || !i.unit.trim()
        || r.quantity_required === null || !Number.isFinite(amount) || amount <= 0 || seen.has(key))
        throw new Error("Invalid recipe");
      seen.add(key);
      const entry = products.get(product) ?? { name: product, parts: [] };
      entry.parts.push({ ingredientId: String(r.ingredient_id), name: i.ingredient_name, unit: i.unit, perDrink: amount });
      products.set(product, entry);
    }
    return { products: [...products.values()].sort((a, b) => a.name.localeCompare(b.name)), error: null };
  } catch {
    return { products: [], error: "Recipes could not be loaded. Check the database connection, recipe quantities and ingredient units." };
  }
}

export async function getRecentSales() {
  try {
    const { data, error } = await inventoryClient().from("inventory_sales")
      .select("id,product_name,quantity,created_at").order("created_at", { ascending: false }).limit(10);
    if (error) throw error;
    return { sales: data as { id: string; product_name: string; quantity: number; created_at: string }[], error: null };
  } catch {
    return { sales: [], error: "Sales history is unavailable. Confirm that inventory-sales.sql has been installed." };
  }
}
