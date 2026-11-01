import "server-only";
import { inventoryClient } from "@/lib/inventory/server";
import type { SaleProduct } from "./model";

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
