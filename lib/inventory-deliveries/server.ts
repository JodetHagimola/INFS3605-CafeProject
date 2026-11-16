import "server-only";
import { inventoryClient } from "@/lib/inventory/server";
import { deliveryWindowState, sydneyDate } from "@/lib/automation/delivery-cycle-model";
import { isSydneyRushTime } from "@/lib/owner-communication-model";

export type Delivery = {
  id: string;
  name: string;
  unit: string;
  outstanding: string;
  ordered: string;
  expected: string;
  supplier: string;
  reference: string;
  demo: boolean;
  status: string;
  arrivalResult: string | null;
  arrivalCheckedAt: string | null;
  windowStart: string | null;
  windowEnd: string | null;
  attention: string[];
};
export type ApprovedOrder = { id: string; created: string; lines: { name: string; amount: string; unit: string; supplier: string }[] };
export type Receipt = { id: string; name: string; amount: string; unit: string; after: string; remaining: string; created: string };
export type DeliveryNotice = { id: string; severity: string; title: string; body: string; created: string };
type Row = Record<string, unknown>;

export async function getDeliveryData(): Promise<{ deliveries: Delivery[]; orders: ApprovedOrder[]; receipts: Receipt[]; notices: DeliveryNotice[]; error: string | null }> {
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
    const [deliveries, ingredients, batches, drafts, recent, lifecycle, suppliers, notices, settings] = await Promise.all([
      all("open_delivery_balances", "delivery_id,ingredient_id,quantity,ordered_quantity,expected_date,supplier_name,batch_id,demo_key,outstanding_quantity", "delivery_id"),
      all("ingredients", "ingredient_id,ingredient_name,unit", "ingredient_id"),
      all("delivery_batches", "id,draft_id,supplier_reference", "id"),
      all("draft_orders", "id,status,lines,created_at", "id"),
      db.from("delivery_receipts").select("id,ingredient_name,amount,unit,stock_after,remaining_after,created_at").order("created_at", { ascending: false }).order("id").limit(20),
      all("incoming_deliveries", "delivery_id,status,arrival_checked_for,arrival_checked_at,arrival_result", "delivery_id"),
      all("suppliers", "name,delivery_window_start,delivery_window_end", "name"),
      db.from("owner_notifications").select("id,severity,title,body,created_at,dedupe_key,surface_after")
        .eq("status", "pending").lte("surface_after", new Date().toISOString())
        .like("dedupe_key", "delivery-%").order("created_at"),
      db.from("cafe_settings").select("rush_windows").eq("id", 1).single(),
    ]);
    if (recent.error) throw recent.error;
    if (notices.error) throw notices.error;
    if (settings.error || !settings.data) throw settings.error ?? new Error("Missing café rush-hour settings.");
    const inRush = isSydneyRushTime(new Date(), settings.data.rush_windows);
    const ingredientMap = new Map(ingredients.map(row => [String(row.ingredient_id), row]));
    const batchMap = new Map(batches.map(row => [String(row.id), row]));
    const lifecycleById = new Map(lifecycle.map(row => [String(row.delivery_id), row]));
    const supplierByName = new Map(suppliers.map(row => [String(row.name), row]));
    const registered = new Set(batches.map(row => String(row.draft_id)));
    const today = sydneyDate(new Date());
    return {
      deliveries: deliveries.filter(row => Number(row.outstanding_quantity) > 0).map(row => {
        const ingredient = ingredientMap.get(String(row.ingredient_id));
        if (!ingredient) throw new Error("Missing ingredient");
        const status = lifecycleById.get(String(row.delivery_id));
        if (!status) throw new Error("Missing delivery lifecycle status");
        const supplierName = typeof row.supplier_name === "string" ? row.supplier_name : "";
        const supplier = supplierByName.get(supplierName);
        const windowStart = typeof supplier?.delivery_window_start === "string" ? supplier.delivery_window_start : null;
        const windowEnd = typeof supplier?.delivery_window_end === "string" ? supplier.delivery_window_end : null;
        const expected = String(row.expected_date).slice(0, 10);
        const arrivalResult = typeof status.arrival_result === "string" ? status.arrival_result : null;
        const attention: string[] = [];
        if (expected < today) attention.push("Overdue");
        if (status.status === "partially_received") attention.push("Partially received");
        if (arrivalResult === "late" && status.arrival_checked_for === expected) attention.push("Simulated arrival was late");
        if (arrivalResult === "short" && status.arrival_checked_for === expected) attention.push("Short arrival");
        if (expected === today && status.arrival_checked_for !== expected && (!windowStart || !windowEnd)) {
          attention.push("Supplier arrival window not configured");
        } else if (expected === today && windowStart && windowEnd && status.arrival_checked_for !== expected) {
          const window = deliveryWindowState(new Date(), expected, windowStart, windowEnd);
          if (window === "open") attention.push("Arrival check is due now");
          if (window === "passed") attention.push("Arrival window passed without a check");
        }
        return { id: String(row.delivery_id), name: String(ingredient.ingredient_name), unit: String(ingredient.unit),
          outstanding: String(row.outstanding_quantity), ordered: String(row.quantity), expected,
          supplier: supplierName || "Not recorded",
          reference: String(batchMap.get(String(row.batch_id))?.supplier_reference ?? (String(row.demo_key).startsWith("SIM-") ? row.demo_key : "Existing incoming delivery")), demo: !!row.demo_key,
          status: String(status.status), arrivalResult,
          arrivalCheckedAt: typeof status.arrival_checked_at === "string" ? status.arrival_checked_at : null,
          windowStart, windowEnd, attention };
      }).sort((a, b) => a.expected.localeCompare(b.expected) || a.id.localeCompare(b.id)),
      orders: drafts.filter(row => row.status === "approved" && !registered.has(String(row.id))).map(row => ({
        id: String(row.id), created: String(row.created_at),
        lines: (row.lines as Row[]).map(line => ({ name: String(line.ingredient), amount: String(line.recommendedOrderQuantity),
          unit: String(line.unit), supplier: String((line.recommendedSupplier as Row)?.supplier ?? "Not recorded") })),
      })).sort((a, b) => b.created.localeCompare(a.created)),
      receipts: recent.data.map(row => ({ id: String(row.id), name: String(row.ingredient_name), amount: String(row.amount),
        unit: String(row.unit), after: String(row.stock_after), remaining: String(row.remaining_after), created: String(row.created_at) })),
      notices: (inRush ? [] : notices.data ?? []).map(row => ({
        id: String(row.id), severity: String(row.severity), title: String(row.title),
        body: typeof row.body === "string" ? row.body : "", created: String(row.created_at),
      })),
      error: null,
    };
  } catch (error) {
    console.error("Could not load delivery operations:", error instanceof Error ? error.message : "Unknown error");
    return { deliveries: [], orders: [], receipts: [], notices: [], error: "Deliveries could not be loaded. Confirm the delivery-cycle migration and inventory-deliveries setup, then refresh." };
  }
}
