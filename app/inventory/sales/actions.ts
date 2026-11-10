"use server";

import { revalidatePath } from "next/cache";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";
import { parseSaleIntent, type SaleReceipt, type SaleResult } from "@/lib/inventory-sales/model";

export async function recordSale(value: unknown): Promise<SaleResult> {
  // Use the same authenticated workspace boundary as the agent routes.
  if (!(await hasAgentSession()))
    return { status: "error", message: "Please sign in before recording sales." };
  const intent = parseSaleIntent(value);
  if (!intent) return { status: "error", message: "Choose a drink and enter a whole number from 1 to 1000." };
  let receipt: SaleReceipt;
  try {
    const { data, error } = await inventoryClient().rpc("record_inventory_sale", {
      p_request_id: intent.id, p_product_name: intent.product, p_quantity: intent.quantity,
    });
    if (error) {
      const messages: Record<string, string> = {
        INVALID_SALE: "Choose a drink and enter a whole number from 1 to 1000.",
        RECIPE_NOT_FOUND: "This drink no longer has a recipe. Refresh the page.",
        INVALID_RECIPE: "The recipe is invalid or duplicated. Ask the team to check it before recording this sale.",
        NO_STOCK_RECORD: "A required ingredient has no inventory record.",
        INVALID_STOCK: "An ingredient has an invalid stock quantity. Check inventory first.",
        INSUFFICIENT_STOCK: "Not enough stock for this sale. No ingredients were deducted.",
      };
      for (const [code, message] of Object.entries(messages)) {
        if (error.message.includes(code)) return { status: "error", message };
      }
      if (error.message.includes("SALE_REQUEST_CONFLICT"))
        return { status: "uncertain", message: "This sale reference already belongs to a different entry. Check sales history before creating another sale." };
      return { status: "uncertain", message: "The sale could not be confirmed. Check sales history and the SQL setup, then retry the same sale. Do not enter it again as a new sale." };
    }
    if (!data || data.sale_id !== intent.id || !Array.isArray(data.changes) || data.changes.length === 0)
      return { status: "uncertain", message: "The response could not be confirmed. Retry this same sale to check its saved result." };
    receipt = data as SaleReceipt;
  } catch {
    return { status: "uncertain", message: "The connection was interrupted. Retry the same sale to confirm it without deducting stock twice." };
  }
  // A failed refresh must not turn a confirmed write into an apparent failure.
  try {
    revalidatePath("/");
    revalidatePath("/inventory");
    revalidatePath("/inventory/sales");
  } catch { /* The receipt still confirms the committed sale. */ }
  return { status: "success", receipt, message: receipt.replayed
    ? "This sale was already saved. No additional stock was deducted."
    : "Sale saved. Ingredient usage has been recorded." };
}
