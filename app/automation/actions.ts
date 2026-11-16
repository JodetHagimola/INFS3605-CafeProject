"use server";

import { revalidatePath } from "next/cache";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";
import { recalculateAutoThresholds } from "@/lib/inventory/thresholds";
import { deliverTestMail, processPendingMail } from "@/lib/automation/mail";
import { scans, simulateScan, type Scan } from "@/lib/automation/sensor";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";

function refreshPages() {
  for (const path of ["/", "/automation", "/inventory", "/inventory/deliveries"]) revalidatePath(path);
}

export async function scanDelivery(_: string, form: FormData) {
  if (!(await hasAgentSession())) return "Sign in to scan a delivery.";
  if (!inventoryWritesEnabled()) return "Stock changes are disabled by server policy.";
  const scenario = String(form.get("scenario")) as Scan;
  const id = String(form.get("delivery"));
  if (!scans.includes(scenario) || !/^\d+$/.test(id)) return "Select an expected delivery and a reading.";
  let reading;
  try {
    reading = simulateScan(id, String(form.get("balance")), String(form.get("unit")), scenario);
  } catch { return "This quantity cannot be simulated. Use the manual receipt form."; }
  const { data, error } = await inventoryClient().rpc("apply_sensor_reading", reading);
  if (error) { refreshPages(); return "The scan could not be recorded. Check the latest outstanding quantity and the database setup."; }
  let message = "Delivery #" + id + " · " + data.outcome + " · " + Number(reading.p_measured) + " " + reading.p_unit + " recorded.";
  if (data.outcome === "short" || data.outcome === "extra") {
    let status = "queued";
    try { status = await deliverTestMail(reading.p_event); } catch { /* The receipt and mail job are already saved. */ }
    message += " Email: " + status.replaceAll("_", " ") + ".";
  }
  refreshPages();
  return message;
}

export async function saveRule(_: string, form: FormData) {
  if (!(await hasAgentSession())) return "Sign in to edit rules.";
  let ingredient, supplier;
  try { [ingredient, supplier] = JSON.parse(String(form.get("quote"))); } catch { return "Choose a supplier quote."; }
  const {error} = await inventoryClient().rpc("configure_cafe_reorder", {
    p_ingredient: ingredient, p_supplier: supplier, p_packs: String(form.get("packs")),
    p_order_limit: String(form.get("limit")), p_daily_limit: String(form.get("daily")),
    p_enabled: form.has("enabled")
  });
  if (error) return "Could not save. Check the stock record, supplier and rule values.";
  try {
    await recalculateAutoThresholds({ force: true });
  } catch (error) {
    console.error("Could not recalculate automatic stock thresholds after a rule change:", error instanceof Error ? error.message : "Unknown error");
    refreshPages();
    return "Rule saved, but automatic thresholds could not be refreshed. Check Activity and the database setup.";
  }
  refreshPages();
  return "Rule saved. Automatic thresholds were refreshed where sales and supplier lead-time data are available.";
}

export async function saveSupplierWindow(_: string, form: FormData) {
  if (!(await hasAgentSession())) return "Sign in to edit supplier delivery windows.";
  const supplier = String(form.get("supplier") ?? "").trim();
  const start = String(form.get("windowStart") ?? "").trim();
  const end = String(form.get("windowEnd") ?? "").trim();
  const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
  if (!supplier || supplier.length > 120) return "Choose a valid supplier.";
  if ((start && !timePattern.test(start)) || (end && !timePattern.test(end))
    || Boolean(start) !== Boolean(end) || (start && end && start >= end)) {
    return "Enter both window times, with the start before the end, or clear both to leave the window unset.";
  }
  const { data, error } = await inventoryClient().from("suppliers")
    .update({
      delivery_window_start: start ? `${start}:00` : null,
      delivery_window_end: end ? `${end}:00` : null,
    })
    .eq("name", supplier)
    .select("name")
    .maybeSingle();
  if (error || !data) return "The supplier window could not be saved. Check the supplier record and database setup.";
  refreshPages();
  return "Supplier delivery window saved in Australia/Sydney time.";
}

export async function reviewOrder(_: string, form: FormData) {
  if (!(await hasAgentSession())) return "Sign in to review orders.";
  if (!inventoryWritesEnabled()) return "Order registration is disabled by server policy.";
  const decision = form.get("decision");
  if (decision !== "approve" && decision !== "reject") return "Choose an action.";
  const {error} = await inventoryClient().rpc("review_cafe_sim_order", {p_id: form.get("order"), p_approve: decision === "approve"});
  if (error) return "Could not review this order. Refresh and try again.";
  refreshPages();
  return "Review complete. See the current order status.";
}

export async function retryMail(_: string) {
  if (!(await hasAgentSession())) return "Sign in to retry email.";
  try { const results = await processPendingMail(); refreshPages(); return results.length + " due email(s) processed."; }
  catch { return "Could not access the queue."; }
}
