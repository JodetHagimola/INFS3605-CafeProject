"use server";

import { revalidatePath } from "next/cache";
import { inventoryClient } from "@/lib/inventory/server";
import { movementAmount } from "@/lib/inventory/model";

export type MovementState = { status: "idle" | "success" | "error"; message: string };

export async function recordMovement(_previous: MovementState, form: FormData): Promise<MovementState> {
  const fail = (message: string): MovementState => ({ status: "error", message });
  // This starter project has no staff login. Writes are limited to the private
  // development demo. Add staff authorization before enabling production writes.
  if (process.env.NODE_ENV !== "development") return fail("Stock updates are available in the private development demo only.");
  const id = String(form.get("id") ?? "");
  const kind = String(form.get("kind") ?? "");
  const amount = movementAmount(form.get("amount"));
  const updated = String(form.get("updated") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!/^\d+$/.test(id) || !["delivery", "usage", "waste"].includes(kind) || amount === null)
    return fail("Enter a positive quantity (up to 6 decimal places) and choose a valid operation.");
  if (!updated || !Number.isFinite(Date.parse(updated))) return fail("Refresh the inventory before recording a change.");
  if (!note || note.length > 200) return fail("Enter a reason of 1–200 characters.");
  try {
    const { error } = await inventoryClient().rpc("record_inventory_movement", {
      p_ingredient_id: id, p_kind: kind, p_amount: amount,
      p_expected_updated: updated, p_note: note,
    });
    if (error) {
      if (error.message.includes("INSUFFICIENT_STOCK")) return fail("This quantity exceeds the stock available. Refresh and try again.");
      if (error.message.includes("STALE_STOCK")) return fail("Stock has changed since this page loaded. Refresh and check the quantity before trying again.");
      if (error.message.includes("NO_STOCK_RECORD")) return fail("No stock record exists for this ingredient.");
      return fail("The database did not confirm the update. Check the inventory before retrying. Confirm the inventory SQL setup has been run.");
    }
  } catch {
    return fail("The update could not be confirmed. Refresh and check the stock before retrying.");
  }
  revalidatePath("/inventory");
  return { status: "success", message: "Stock updated. The movement and reason have been recorded." };
}
