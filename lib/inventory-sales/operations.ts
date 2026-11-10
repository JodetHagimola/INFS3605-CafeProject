import "server-only";
import { inventoryClient } from "@/lib/inventory/server";
import { isValidISODate } from "@/lib/agent/date";
import type { RecordedOperations } from "./operations-model";

export async function getRecordedOperations(date: string): Promise<RecordedOperations> {
  if (!isValidISODate(date)) throw new Error("Choose a valid date.");
  const { data, error } = await inventoryClient().rpc("inventory_recorded_operations", { p_date: date });
  if (error || !data || data.date !== date || !Array.isArray(data.ingredientsUsed) || !Array.isArray(data.deliveriesReceived)) {
    throw new Error("Recorded sales and receipts could not be loaded. Check inventory-agent-integration.sql.");
  }
  return data as RecordedOperations;
}
