import "server-only";

import { inventoryClient } from "@/lib/inventory/server";

export type DataRow = Record<string, unknown>;

const ORDER_COLUMNS: Record<string, string[]> = {
  ingredients: ["ingredient_id"],
  recipes: ["product_name", "ingredient_id"],
  sales_history: ["sales_date", "product_name"],
  incoming_deliveries: ["delivery_id"],
  delivery_receipts: ["id"],
  supplier_prices: ["supplier", "ingredient_id"],
};

export async function readAll(table: string, columns: string): Promise<DataRow[]> {
  const db = inventoryClient();
  const rows: DataRow[] = [];

  for (let offset = 0; ; offset += 500) {
    let query = db.from(table).select(columns);
    for (const column of ORDER_COLUMNS[table] ?? ["id"]) {
      query = query.order(column);
    }
    const { data, error } = await query.range(offset, offset + 499);
    if (error) {
      console.error(`Could not read agent data from ${table}:`, error.message);
      throw new Error(`The required ${table} data could not be read.`);
    }

    rows.push(...(data as unknown as DataRow[]));
    if (data.length < 500) return rows;
  }
}

export function textValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value.trim();
}

export function idValue(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return String(value);
}

export function nonnegativeNumber(value: unknown, label: string): number {
  if ((typeof value !== "number" && typeof value !== "string") || String(value).trim() === "") {
    throw new Error(`${label} is missing or invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return parsed;
}

export function validDate(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} is missing or invalid.`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}
