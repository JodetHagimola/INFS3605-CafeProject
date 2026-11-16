import "server-only";
import { createClient } from "@supabase/supabase-js";
import { numeric, stockStatus, type InventoryItem } from "./model";
import { isStockCountDue } from "./automation-model";

export function inventoryClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase configuration is missing.");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

export async function getInventory(): Promise<{ items: InventoryItem[]; error: string | null }> {
  try {
    const db = inventoryClient();
    // Explicit pagination avoids silently truncating Supabase's default row limit.
    async function readAll(table: string, columns: string) {
      const rows: Record<string, unknown>[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.from(table).select(columns)
          .order("ingredient_id").range(offset, offset + 499);
        if (error) throw error;
        rows.push(...(data as unknown as Record<string, unknown>[]));
        if (data.length < 500) return rows;
      }
    }
    const [ingredients, inventory] = await Promise.all([
      readAll("ingredients", "ingredient_id,ingredient_name,unit"),
      readAll("inventory", "ingredient_id,quantity_in_stock,last_updated,minimum_stock,last_counted_at,auto_threshold"),
    ]);
    const byId = new Map(inventory.map(row => [String(row.ingredient_id), row]));
    const items = ingredients.map(ingredient => {
      const row = byId.get(String(ingredient.ingredient_id));
      const quantity = numeric(row?.quantity_in_stock);
      const minimum = numeric(row?.minimum_stock);
      const invalidMinimum = row?.minimum_stock != null && minimum === null;
      const lastCounted = typeof row?.last_counted_at === "string" ? row.last_counted_at : null;
      return {
        id: String(ingredient.ingredient_id), name: String(ingredient.ingredient_name),
        unit: String(ingredient.unit), quantity, minimum,
        updated: typeof row?.last_updated === "string" ? row.last_updated : null,
        lastCounted,
        countDue: isStockCountDue(lastCounted, Date.now()),
        autoThreshold: row?.auto_threshold === true,
        status: invalidMinimum ? "Check data" as const : stockStatus(!!row, quantity, minimum),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));
    return { items, error: null };
  } catch {
    return { items: [], error: "Inventory could not be loaded. Check the server Supabase settings and confirm inventory.minimum_stock exists. No stock values have been assumed." };
  }
}
