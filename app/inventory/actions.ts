"use server";

import { revalidatePath } from "next/cache";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";
import { countedAmount } from "@/lib/inventory/model";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";

export type CountState = { status: "idle" | "success" | "error"; message: string };

export async function recordInventoryCount(_previous: CountState, form: FormData): Promise<CountState> {
  const fail = (message: string): CountState => ({ status: "error", message });
  if (!(await hasAgentSession())) return fail("Please sign in before correcting stock.");
  if (!inventoryWritesEnabled()) return fail("Stock changes are disabled by server policy.");
  const id = String(form.get("id") ?? "");
  const amount = countedAmount(form.get("amount"));
  const updated = String(form.get("updated") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!/^\d+$/.test(id) || amount === null)
    return fail("Enter the counted quantity using up to 6 decimal places.");
  if (!updated || !Number.isFinite(Date.parse(updated))) return fail("Refresh the inventory before correcting stock.");
  if (!note || note.length > 200) return fail("Enter a reason of 1–200 characters.");
  try {
    const { error } = await inventoryClient().rpc("record_inventory_count", {
      p_ingredient_id: id, p_counted_quantity: amount,
      p_expected_updated: updated, p_note: note,
    });
    if (error) {
      if (error.message.includes("STALE_STOCK")) return fail("Stock changed since this page loaded. Refresh and count it again before saving.");
      if (error.message.includes("NO_STOCK_RECORD")) return fail("No stock record exists for this ingredient.");
      return fail("The count was not confirmed. Check stock before retrying and confirm the automation migration has been applied.");
    }
  } catch {
    return fail("The count could not be confirmed. Refresh and check stock before retrying.");
  }
  try { revalidatePath("/"); revalidatePath("/inventory"); } catch { /* Stock was committed. */ }
  return { status: "success", message: "Count saved. Any difference and the reason were added to the stock ledger." };
}
