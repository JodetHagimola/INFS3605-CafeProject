import "server-only";

import { numeric } from "./model";
import { calculateAutomaticMinimum } from "./automation-model";
import { inventoryClient } from "./server";
import { inventoryWritesEnabled } from "./write-policy";
import { withAgentActivity } from "@/lib/agent/tools/activity";

type Row = Record<string, unknown>;

function recordRow(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The inventory query returned an invalid row.");
  }
  const row: Row = {};
  for (const [key, field] of Object.entries(value)) row[key] = field;
  return row;
}

async function readAll(table: string, columns: string, order: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await inventoryClient()
      .from(table)
      .select(columns)
      .order(order)
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
    rows.push(...data.map(recordRow));
    if (data.length < 500) return rows;
  }
}

function leadDays(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed !== null && Number.isInteger(parsed) && parsed >= 0 && parsed <= 365 ? parsed : null;
}

async function runThresholdTask<T>(
  input: unknown,
  ingredientId: string,
  execute: () => Promise<T>,
): Promise<T> {
  const db = inventoryClient();
  const { data, error } = await db.from("agent_tasks")
    .insert({
      kind: "recalculate_auto_threshold",
      payload: { ingredient_id: ingredientId },
      status: "running",
      attempts: 1,
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`Could not create an automatic-threshold task for ingredient ${ingredientId}: ${error?.message ?? "No task returned"}`);
  }

  try {
    const result = await withAgentActivity(
      "recalculate_auto_threshold",
      input,
      async () => execute(),
      { trigger: "weekly_threshold_recalculation", taskId: String(data.id) },
    );
    const { error: finishError } = await db.from("agent_tasks")
      .update({ status: "done", finished_at: new Date().toISOString() })
      .eq("id", data.id);
    if (finishError) throw new Error(`Threshold task ${data.id} could not be marked complete: ${finishError.message}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : "The threshold task failed.";
    const { error: updateError } = await db.from("agent_tasks")
      .update({ status: "failed", last_error: message.slice(0, 1000), finished_at: new Date().toISOString() })
      .eq("id", data.id);
    if (updateError) {
      console.error("Could not mark an automatic-threshold task failed:", updateError.message);
    }
    throw error;
  }
}

export async function recalculateAutoThresholds(options: {
  force?: boolean;
  now?: Date;
} = {}): Promise<{ updated: number; checked: number; skipped: number }> {
  if (!inventoryWritesEnabled()) throw new Error("Inventory writes are disabled by server policy.");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Threshold recalculation time is invalid.");

  const [inventory, usage, rules, prices, suppliers] = await Promise.all([
    readAll("inventory", "ingredient_id,minimum_stock,auto_threshold,auto_threshold_updated_at", "ingredient_id"),
    readAll("brewly_avg_daily_usage", "ingredient_id,avg_daily_usage", "ingredient_id"),
    readAll("cafe_reorder_rules", "ingredient_id,supplier", "ingredient_id"),
    readAll("supplier_prices", "ingredient_id,supplier,lead_time_days", "ingredient_id"),
    readAll("suppliers", "name,lead_time_days", "name"),
  ]);
  const usageById = new Map(usage.map((row) => [String(row.ingredient_id), numeric(row.avg_daily_usage)]));
  const supplierById = new Map(rules.map((row) => [String(row.ingredient_id), String(row.supplier ?? "")]));
  const supplierLeadByName = new Map(suppliers.map((row) => [String(row.name), leadDays(row.lead_time_days)]));
  const supplierPriceLead = new Map<string, number | null>();
  for (const row of prices) {
    const key = `${String(row.ingredient_id)}\u0000${String(row.supplier)}`;
    const lead = leadDays(row.lead_time_days);
    if (supplierPriceLead.has(key) && supplierPriceLead.get(key) !== lead) {
      supplierPriceLead.set(key, null);
    } else {
      supplierPriceLead.set(key, lead);
    }
  }
  const cutoff = now.getTime() - 7 * 24 * 60 * 60 * 1000;
  let updated = 0;
  let checked = 0;
  let skipped = 0;

  for (const row of inventory) {
    if (row.auto_threshold !== true) continue;
    const id = String(row.ingredient_id);
    const previousCheck = typeof row.auto_threshold_updated_at === "string"
      ? Date.parse(row.auto_threshold_updated_at)
      : NaN;
    if (!options.force && Number.isFinite(previousCheck) && previousCheck > cutoff) continue;

    const supplier = supplierById.get(id);
    const dailyUsage = usageById.get(id);
    const supplierLead = supplier
      ? supplierLeadByName.get(supplier)
        ?? supplierPriceLead.get(`${id}\u0000${supplier}`)
      : null;
    const minimum = dailyUsage !== undefined && dailyUsage !== null && supplierLead !== undefined && supplierLead !== null
      ? calculateAutomaticMinimum(dailyUsage, supplierLead)
      : null;
    if (!supplier || minimum === null) {
      skipped += 1;
      await runThresholdTask(
        { ingredient_id: id, supplier: supplier ?? null },
        id,
        async () => ({ status: "blocked", flags: ["Recent usage, a preferred supplier, or a valid lead time is unavailable."] }),
      );
      continue;
    }

    const currentMinimum = numeric(row.minimum_stock);
    await runThresholdTask(
      { ingredient_id: id, minimum_stock: minimum },
      id,
      async () => {
        const { data, error } = await inventoryClient()
          .from("inventory")
          .update({
            minimum_stock: minimum,
            auto_threshold_updated_at: now.toISOString(),
          })
          .eq("ingredient_id", id)
          .eq("auto_threshold", true)
          .select("ingredient_id")
          .maybeSingle();
        if (error) throw new Error(`Could not update the threshold for ingredient ${id}: ${error.message}`);
        if (!data) throw new Error(`The automatic threshold for ingredient ${id} changed during recalculation.`);
        return { status: "updated", changed: currentMinimum !== minimum };
      },
    );
    checked += 1;
    if (currentMinimum !== minimum) updated += 1;
  }

  return { updated, checked, skipped };
}
