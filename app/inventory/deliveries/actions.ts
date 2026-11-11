"use server";
import { revalidatePath } from "next/cache";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";
import { movementAmount } from "@/lib/inventory/model";

export type DeliveryState = { status: "idle" | "success" | "error"; message: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message: string): DeliveryState => ({ status: "error", message });
function refresh() {
  try {
    for (const path of ["/", "/inventory/deliveries", "/inventory", "/inventory/sales", "/automated-ordering"]) revalidatePath(path);
  } catch { /* A confirmed receipt stays successful if page revalidation fails. */ }
}
export async function registerDelivery(_previous: DeliveryState, form: FormData): Promise<DeliveryState> {
  if (!(await hasAgentSession())) return fail("Please sign in before updating deliveries.");
  const id = String(form.get("draftId") ?? "");
  const date = String(form.get("expected") ?? "");
  const reference = String(form.get("reference") ?? "").trim();
  if (!uuid.test(id) || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
    || new Date(date).toISOString().slice(0, 10) !== date || !reference || reference.length > 120 || form.get("placed") !== "yes")
    return fail("Enter an expected date and order reference, and confirm the order has already been placed.");
  try {
    const { data, error } = await inventoryClient().rpc("register_order_delivery", { p_draft_id: id, p_expected_date: date, p_reference: reference });
    if (error) {
      if (error.message.includes("ORDER_ALREADY_REGISTERED")) return fail("This order is already registered. Refresh and check the pending deliveries.");
      if (error.message.includes("ORDER_NOT_APPROVED")) return fail("Approve the order on AI Forecast first.");
      return fail("Registration was not confirmed. Refresh and check pending deliveries before retrying. Check the order quantities, units and SQL setup.");
    }
    refresh();
    return { status: "success", message: data.replayed ? "This order was already registered; nothing was added again." : "Delivery registered. Stock will increase only when goods are received." };
  } catch { return fail("Registration was not confirmed. Refresh and check pending deliveries before retrying."); }
}
export async function receiveDelivery(_previous: DeliveryState, form: FormData): Promise<DeliveryState> {
  if (!(await hasAgentSession())) return fail("Please sign in before updating deliveries.");
  const request = String(form.get("request") ?? "");
  const delivery = String(form.get("delivery") ?? "");
  const amount = movementAmount(form.get("amount"));
  const expected = String(form.get("remaining") ?? "");
  const note = String(form.get("note") ?? "").trim();
  if (!uuid.test(request) || !/^\d{1,18}$/.test(delivery) || amount === null || movementAmount(expected) === null || !note || note.length > 120 || form.get("received") !== "yes")
    return fail("Enter the actual received quantity and a delivery note, and confirm the goods have arrived.");
  try {
    const { data, error } = await inventoryClient().rpc("receive_inventory_delivery", {
      p_request_id: request, p_delivery_id: delivery, p_amount: String(form.get("amount")), p_expected_remaining: expected, p_note: note,
    });
    if (error) {
      if (error.message.includes("DELIVERY_CHANGED")) return fail("This delivery changed or was already received. Refresh and check the receipt history before entering anything else.");
      if (error.message.includes("EXCEEDS_OUTSTANDING")) return fail("Received quantity exceeds the amount still expected. Check the quantity and unit.");
      if (error.message.includes("RECEIPT_REQUEST_CONFLICT")) return fail("This receipt reference was used with different details. Refresh and check receipt history.");
      return fail("Receipt was not confirmed. Keep these details and retry, or check receipt history. Confirm the SQL setup and stock records.");
    }
    refresh();
    return { status: "success", message: `${data.replayed ? "Already recorded" : "Receipt recorded"}: ${data.amount} ${data.unit} ${data.name}. Stock at receipt: ${data.before} → ${data.after} ${data.unit}. Still expected: ${data.remaining} ${data.unit}.` };
  } catch { return fail("Receipt was not confirmed. Keep these details and retry, or refresh and check receipt history."); }
}
