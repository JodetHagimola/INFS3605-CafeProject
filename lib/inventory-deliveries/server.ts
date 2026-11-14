import "server-only";
import { inventoryClient } from "@/lib/inventory/server";

export type Delivery = { id: string; name: string; unit: string; outstanding: string; ordered: string; expected: string; supplier: string; reference: string; demo: boolean };
export type ApprovedOrder = { id: string; created: string; lines: { name: string; amount: string; unit: string; supplier: string }[] };
export type Receipt = { id: string; name: string; amount: string; unit: string; after: string; remaining: string; created: string };
type Row = Record<string, unknown>;

export async function getDeliveryData(): Promise<{ deliveries: Delivery[]; orders: ApprovedOrder[]; receipts: Receipt[]; error: string | null }> {
  try {
    const db = inventoryClient();
    async function all(table: string, columns: string, key: string): Promise<Row[]> {
      const rows: Row[] = [];
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await db.from(table).select(columns).order(key).range(offset, offset + 499);
        if (error) throw error;
        rows.push(...data as unknown as Row[]);
        if (data.length < 500) return rows;
      }
    }
    const [deliveries, ingredients, batches, drafts, recent] = await Promise.all([
      all("open_delivery_balances", "delivery_id,ingredient_id,quantity,ordered_quantity,expected_date,supplier_name,batch_id,demo_key,outstanding_quantity", "delivery_id"),
      all("ingredients", "ingredient_id,ingredient_name,unit", "ingredient_id"),
      all("delivery_batches", "id,draft_id,supplier_reference", "id"),
      all("draft_orders", "id,status,lines,created_at", "id"),
      db.from("delivery_receipts").select("id,ingredient_name,amount,unit,stock_after,remaining_after,created_at").order("created_at", { ascending: false }).order("id").limit(20),
    ]);
    if (recent.error) throw recent.error;
    const ingredientMap = new Map(ingredients.map(row => [String(row.ingredient_id), row]));
    const batchMap = new Map(batches.map(row => [String(row.id), row]));
    const registered = new Set(batches.map(row => String(row.draft_id)));
    return {
      deliveries: deliveries.filter(row => Number(row.outstanding_quantity) > 0).map(row => {
        const ingredient = ingredientMap.get(String(row.ingredient_id));
        if (!ingredient) throw new Error("Missing ingredient");
        return { id: String(row.delivery_id), name: String(ingredient.ingredient_name), unit: String(ingredient.unit),
          outstanding: String(row.outstanding_quantity), ordered: String(row.quantity), expected: String(row.expected_date).slice(0, 10),
          supplier: typeof row.supplier_name === "string" ? row.supplier_name : "Not recorded",
          reference: String(batchMap.get(String(row.batch_id))?.supplier_reference ?? (String(row.demo_key).startsWith("SIM-") ? row.demo_key : "Existing incoming delivery")), demo: !!row.demo_key };
      }).sort((a, b) => a.expected.localeCompare(b.expected) || a.id.localeCompare(b.id)),
      orders: drafts.filter(row => row.status === "approved" && !registered.has(String(row.id))).map(row => ({
        id: String(row.id), created: String(row.created_at),
        lines: (row.lines as Row[]).map(line => ({ name: String(line.ingredient), amount: String(line.recommendedOrderQuantity),
          unit: String(line.unit), supplier: String((line.recommendedSupplier as Row)?.supplier ?? "Not recorded") })),
      })).sort((a, b) => b.created.localeCompare(a.created)),
      receipts: recent.data.map(row => ({ id: String(row.id), name: String(row.ingredient_name), amount: String(row.amount),
        unit: String(row.unit), after: String(row.stock_after), remaining: String(row.remaining_after), created: String(row.created_at) })),
      error: null,
    };
  } catch {
    return { deliveries: [], orders: [], receipts: [], error: "Deliveries could not be loaded. Confirm the inventory, automated-ordering drafts and inventory-deliveries SQL have been installed, then refresh." };
  }
}
