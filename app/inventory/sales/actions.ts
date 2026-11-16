"use server";

import { revalidatePath } from "next/cache";
import { hasAgentSession } from "@/lib/agent/auth";
import { persistSale } from "@/lib/inventory-sales/server";
import { parseSaleIntent, type SaleResult } from "@/lib/inventory-sales/model";

export async function recordSale(value: unknown): Promise<SaleResult> {
  if (!(await hasAgentSession()))
    return { status: "error", message: "Please sign in before recording sales." };
  const intent = parseSaleIntent(value);
  if (!intent) return { status: "error", message: "Choose a drink and enter a whole number from 1 to 1000." };
  const result = await persistSale(intent, "manual");
  if (result.status === "success") {
    try {
      revalidatePath("/");
      revalidatePath("/inventory");
      revalidatePath("/inventory/sales");
    } catch { /* The receipt still confirms the committed sale. */ }
  }
  return result;
}
