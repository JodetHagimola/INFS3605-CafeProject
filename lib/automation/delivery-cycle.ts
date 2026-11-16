import "server-only";

import { inventoryClient } from "@/lib/inventory/server";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import {
  deliveryFollowupAction,
  deliveryWindowState,
  deterministicDeliveryId,
  quantityDifference,
  shortageExceedsPercent,
  simulatedReceivedQuantity,
  simulateArrivalOutcome,
  sydneyDate,
  sumQuantities,
  withinDeliveryTolerance,
} from "./delivery-cycle-model";
import { supplierDraft, type ShortageRow } from "@/lib/inventory-deliveries/shortage-email";

type Row = Record<string, unknown>;

function rowValue(value: unknown, field: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The delivery cycle returned an invalid ${field}.`);
  }
  return value as Row;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`The delivery cycle is missing ${field}.`);
  return value.trim();
}

function quantity(value: unknown, field: string): string {
  const parsed = typeof value === "number" ? String(value) : value;
  if (typeof parsed !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(parsed)) {
    throw new Error(`The delivery cycle received an invalid ${field}.`);
  }
  return parsed;
}

async function readAll(table: string, columns: string, order: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await inventoryClient()
      .from(table)
      .select(columns)
      .order(order)
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not read ${table} for delivery automation: ${error.message}`);
    rows.push(...data.map((value) => rowValue(value, table)));
    if (data.length < 500) return rows;
  }
}

function notificationText(
  action: "decision" | "lapse",
  delivery: Row,
  ingredient: string,
  supplier: string | null,
): { title: string; body: string } {
  const id = text(String(delivery.delivery_id), "delivery ID");
  const reference = supplier ? ` from ${supplier}` : "";
  if (action === "lapse") {
    return {
      title: `Delivery #${id} has lapsed`,
      body: `${ingredient}${reference} was not received within seven days and is no longer counted as incoming stock. Review replacement options; no order has been placed.`,
    };
  }
  return {
    title: `Delivery #${id} is still overdue`,
    body: `${ingredient}${reference} is still missing after two supplier chases. Decide whether to seek a replacement supplier or keep waiting. No order has been placed.`,
  };
}

async function saveShortageFollowup(
  delivery: Row,
  eventId: string,
  ordered: string,
  unit: string,
  ingredient: string,
  supplier: string | null,
  reference: string,
  receiptRows: Row[],
  minimum: unknown,
): Promise<boolean> {
  const received = sumQuantities(receiptRows.map((receipt) => quantity(receipt.amount, "receipt amount")));
  const missing = quantityDifference(ordered, received);
  const lastReceipt = receiptRows.at(-1);
  if (!lastReceipt || missing === "0") return true;
  const stockAfter = quantity(lastReceipt.stock_after, "stock after receipt");
  const draftFacts = {
    reference,
    supplier,
    ingredient,
    unit,
    ordered,
    received,
    missing,
    stockAfter,
    minimum: minimum == null ? null : quantity(minimum, "minimum stock"),
  };
  const draft = supplierDraft({
    receipt_id: eventId,
    facts: draftFacts,
    approach: null,
  } as ShortageRow);
  const needsOwner = shortageExceedsPercent(ordered, received, 25);
  const result = await inventoryClient().rpc("save_delivery_shortage_followup", {
    p_event: eventId,
    p_delivery_id: delivery.delivery_id,
    p_draft_facts: draftFacts,
    p_mail_facts: {
      receipt: eventId,
      kind: "short",
      reference,
      supplier,
      ingredient,
      ordered,
      received,
      difference: missing,
      unit,
    },
    p_mail_payload: {
      from: "Brewly <cafe@test.invalid>",
      to: "Delivery test inbox <supplier@test.invalid>",
      subject: draft.subject,
      text: draft.body,
    },
    p_needs_owner: needsOwner,
    p_notification_title: needsOwner ? `Significant shortage: ${ingredient}` : null,
    p_notification_body: needsOwner
      ? `Delivery #${delivery.delivery_id} is short by ${missing} ${unit}, more than 25% of the ${ordered} ${unit} ordered. The remainder remains expected. Review the saved supplier draft; no external email was sent.`
      : null,
  });
  if (result.error) {
    throw new Error(`Could not save the short-delivery followup: ${result.error.message}`);
  }
  const saved = rowValue(result.data, "short-delivery followup result");
  if (saved.status === "paused") return false;
  if (saved.status !== "saved") throw new Error("The short-delivery followup returned an unknown status.");
  return true;
}

function chaseMessage(
  delivery: Row,
  ingredient: string,
  supplier: string | null,
  reference: string,
  ordered: string,
  received: string,
  missing: string,
  unit: string,
  attempt: number,
) {
  const subject = `Overdue delivery follow-up for ${reference}`;
  const body = [
    supplier ? `Hello ${supplier} team,` : "Hello,",
    `We are following up on ${reference}, expected on ${delivery.expected_date}. We ordered ${ordered} ${unit} of ${ingredient} and have received ${received} ${unit}; ${missing} ${unit} remains outstanding.`,
    "Could you confirm the delivery status and expected arrival time?",
    "Thank you.",
  ].join("\n\n");
  return {
    subject,
    body,
    facts: {
      kind: "chase",
      delivery_id: String(delivery.delivery_id),
      attempt,
      reference,
      supplier,
      ingredient,
      ordered,
      received,
      missing,
      unit,
    },
    payload: {
      from: "Brewly <cafe@test.invalid>",
      to: "Delivery test inbox <supplier@test.invalid>",
      subject,
      text: body,
    },
  };
}

export async function runDeliveryCycle(now = new Date()): Promise<{
  status: "paused" | "blocked_email_mode" | "completed";
  checked: number;
  received: number;
  short: number;
  late: number;
  chased: number;
  decisions: number;
  lapsed: number;
  missingWindows: number;
}> {
  if (!inventoryWritesEnabled()) throw new Error("Inventory writes are disabled by server policy.");
  if (!Number.isFinite(now.getTime())) throw new Error("Delivery cycle time is invalid.");
  const db = inventoryClient();
  const { data: settings, error: settingsError } = await db
    .from("cafe_settings")
    .select("automation_paused,email_mode")
    .eq("id", 1)
    .single();
  if (settingsError || !settings) {
    throw new Error(`Could not read delivery automation settings: ${settingsError?.message ?? "No settings row returned"}`);
  }
  if (settings.automation_paused === true) {
    return { status: "paused", checked: 0, received: 0, short: 0, late: 0, chased: 0, decisions: 0, lapsed: 0, missingWindows: 0 };
  }
  if (settings.email_mode !== "test") {
    return { status: "blocked_email_mode", checked: 0, received: 0, short: 0, late: 0, chased: 0, decisions: 0, lapsed: 0, missingWindows: 0 };
  }

  const today = sydneyDate(now);
  const [deliveryRows, suppliers, ingredients] = await Promise.all([
    db.from("agent_delivery_status")
      .select("delivery_id,ingredient_id,quantity,expected_date,supplier_name,stock_unit,status,chase_count,last_chased_at,arrival_checked_for,arrival_result,batch_id,demo_key,closed_short")
      .in("status", ["expected", "partially_received"])
      .eq("closed_short", false)
      .lte("expected_date", today)
      .order("delivery_id"),
    readAll("suppliers", "name,delivery_window_start,delivery_window_end", "name"),
    readAll("ingredients", "ingredient_id,ingredient_name,unit", "ingredient_id"),
  ]);
  if (deliveryRows.error) throw new Error(`Could not read open deliveries: ${deliveryRows.error.message}`);
  const deliveries = (deliveryRows.data ?? []).map((value) => rowValue(value, "delivery"));
  const deliveryIds = deliveries.map((delivery) => String(delivery.delivery_id));
  const batchIds = [...new Set(deliveries
    .map((delivery) => delivery.batch_id)
    .filter((value) => typeof value === "string" || typeof value === "number")
    .map(String))];
  const [receiptsResult, batchesResult, inventoryResult] = await Promise.all([
    deliveryIds.length
      ? db.from("delivery_receipts").select("id,delivery_id,amount,remaining_after,stock_after")
        .in("delivery_id", deliveryIds).order("created_at").order("id")
      : Promise.resolve({ data: [], error: null }),
    batchIds.length
      ? db.from("delivery_batches").select("id,supplier_reference").in("id", batchIds)
      : Promise.resolve({ data: [], error: null }),
    db.from("inventory").select("ingredient_id,minimum_stock"),
  ]);
  for (const [table, error] of [
    ["delivery receipts", receiptsResult.error],
    ["delivery batches", batchesResult.error],
    ["inventory", inventoryResult.error],
  ] as const) {
    if (error) throw new Error(`Could not read ${table}: ${error.message}`);
  }

  const supplierByName = new Map(suppliers.map((supplier) => [text(supplier.name, "supplier name"), supplier]));
  const ingredientById = new Map(ingredients.map((ingredient) => [String(ingredient.ingredient_id), ingredient]));
  const batchById = new Map((batchesResult.data ?? []).map((batch) => [String(batch.id), batch]));
  const minimumByIngredient = new Map((inventoryResult.data ?? []).map((row) => [String(row.ingredient_id), row.minimum_stock]));
  const receiptsByDelivery = new Map<string, Row[]>();
  for (const value of receiptsResult.data ?? []) {
    const receipt = rowValue(value, "receipt");
    const id = String(receipt.delivery_id);
    const rows = receiptsByDelivery.get(id) ?? [];
    rows.push(receipt);
    receiptsByDelivery.set(id, rows);
  }

  const result = {
    status: "completed" as const,
    checked: 0,
    received: 0,
    short: 0,
    late: 0,
    chased: 0,
    decisions: 0,
    lapsed: 0,
    missingWindows: 0,
  };

  for (const delivery of deliveries) {
    const deliveryId = text(String(delivery.delivery_id), "delivery ID");
    const ingredientId = text(String(delivery.ingredient_id), "ingredient ID");
    const ingredientRow = ingredientById.get(ingredientId);
    if (!ingredientRow) throw new Error(`Delivery ${deliveryId} references a missing ingredient.`);
    const ingredient = text(ingredientRow.ingredient_name, "ingredient name");
    const unit = text(delivery.stock_unit, "delivery stock unit");
    const expectedDate = text(delivery.expected_date, "expected date").slice(0, 10);
    let arrivalResult = typeof delivery.arrival_result === "string" ? delivery.arrival_result : null;
    let saveShortFollowup = delivery.arrival_checked_for === expectedDate && arrivalResult === "short";
    const ordered = quantity(delivery.quantity, "ordered quantity");
    const receiptRows = receiptsByDelivery.get(deliveryId) ?? [];
    const received = sumQuantities(receiptRows.map((receipt) => quantity(receipt.amount, "receipt amount")));
    const outstanding = quantityDifference(ordered, received);
    if (outstanding === "0") continue;
    const supplierName = typeof delivery.supplier_name === "string" && delivery.supplier_name.trim()
      ? delivery.supplier_name.trim()
      : null;
    const supplier = supplierName ? supplierByName.get(supplierName) ?? null : null;
    const batch = delivery.batch_id ? batchById.get(String(delivery.batch_id)) : null;
    const reference = typeof batch?.supplier_reference === "string" && batch.supplier_reference.trim()
      ? batch.supplier_reference.trim()
      : typeof delivery.demo_key === "string" && delivery.demo_key.trim()
        ? delivery.demo_key.trim()
        : `Delivery #${deliveryId}`;

    if (expectedDate === today && delivery.arrival_checked_for !== expectedDate) {
      const windowState = deliveryWindowState(
        now,
        expectedDate,
        typeof supplier?.delivery_window_start === "string" ? supplier.delivery_window_start : null,
        typeof supplier?.delivery_window_end === "string" ? supplier.delivery_window_end : null,
      );
      if (windowState === "missing_window") {
        result.missingWindows += 1;
      } else if (windowState === "open") {
        result.checked += 1;
        const simulated = simulateArrivalOutcome(deliveryId, expectedDate);
        if (simulated.kind === "late") {
          const { data, error } = await db.rpc("record_simulated_delivery_late", {
            p_delivery_id: delivery.delivery_id,
            p_expected_date: expectedDate,
            p_checked_at: now.toISOString(),
          });
          if (error) throw new Error(`Could not record late arrival simulation for delivery ${deliveryId}: ${error.message}`);
          const lateResult = rowValue(data, "late arrival result");
          if (lateResult.status === "paused") return { ...result, status: "paused" };
          arrivalResult = "late";
          if (lateResult.status === "recorded") result.late += 1;
        } else {
          const measured = simulated.kind === "complete"
            ? outstanding
            : simulatedReceivedQuantity(outstanding, simulated.missingPercent) ?? outstanding;
          const outcome = withinDeliveryTolerance(outstanding, measured) ? "complete" : "short";
          const eventId = deterministicDeliveryId("arrival", deliveryId, expectedDate);
          const { data, error } = await db.rpc("record_simulated_delivery_arrival", {
            p_event: eventId,
            p_delivery_id: delivery.delivery_id,
            p_expected_date: expectedDate,
            p_measured: measured,
            p_expected: outstanding,
            p_unit: unit,
            p_result: outcome,
            p_checked_at: now.toISOString(),
          });
          if (error) throw new Error(`Could not record simulated arrival for delivery ${deliveryId}: ${error.message}`);
          const arrival = rowValue(data, "simulated arrival result");
          if (arrival.status === "paused") return { ...result, status: "paused" };
          if (typeof arrival.outcome !== "string") {
            throw new Error(`Simulated arrival for delivery ${deliveryId} returned no outcome.`);
          }
          arrivalResult = arrival.outcome;
          saveShortFollowup = arrival.outcome === "short";
          if (arrival.status === "already_checked") {
            // A retry can still finish the test-mail and shortage-draft work below.
          } else if (arrival.outcome === "complete") {
            result.received += 1;
          } else if (arrival.outcome === "short") {
            result.short += 1;
          } else {
            throw new Error(`Simulated arrival for delivery ${deliveryId} returned an unknown outcome.`);
          }
        }
      }
    }

    if (saveShortFollowup) {
      const eventId = deterministicDeliveryId("arrival", deliveryId, expectedDate);
      const currentReceipts = await db.from("delivery_receipts")
        .select("id,delivery_id,amount,remaining_after,stock_after")
        .eq("delivery_id", deliveryId)
        .order("created_at")
        .order("id");
      if (currentReceipts.error) throw new Error(`Could not reload receipts for delivery ${deliveryId}: ${currentReceipts.error.message}`);
      const saved = await saveShortageFollowup(
        delivery,
        eventId,
        ordered,
        unit,
        ingredient,
        supplierName,
        reference,
        (currentReceipts.data ?? []).map((value) => rowValue(value, "receipt")),
        minimumByIngredient.get(ingredientId) ?? null,
      );
      if (!saved) return { ...result, status: "paused" };
    }

    if (expectedDate >= today) continue;
    const action = deliveryFollowupAction(
      expectedDate,
      today,
      Number(delivery.chase_count ?? 0),
      typeof delivery.last_chased_at === "string" ? delivery.last_chased_at : null,
      now,
    );
    if (action === "none") continue;
    const followup = notificationText(action === "lapse" ? "lapse" : "decision", delivery, ingredient, supplierName);
    const attempt = Number(delivery.chase_count ?? 0) + 1;
    const chase = action === "chase"
      ? chaseMessage(delivery, ingredient, supplierName, reference, ordered, received, outstanding, unit, attempt)
      : null;
    const mailEvent = chase ? deterministicDeliveryId("chase", deliveryId, String(attempt)) : null;
    const { data, error } = await db.rpc("apply_delivery_followup", {
      p_delivery_id: delivery.delivery_id,
      p_today: today,
      p_now: now.toISOString(),
      p_action: action,
      p_mail_event: mailEvent,
      p_mail_facts: chase?.facts ?? null,
      p_mail_payload: chase?.payload ?? null,
      p_notification_title: action === "chase" ? null : followup.title,
      p_notification_body: action === "chase" ? null : followup.body,
    });
    if (error) throw new Error(`Could not process overdue delivery ${deliveryId}: ${error.message}`);
    const status = rowValue(data, "followup result").status;
    if (status === "paused") return { ...result, status: "paused" };
    if (status === "chase_queued") result.chased += 1;
    if (status === "decision_queued") result.decisions += 1;
    if (status === "lapsed") result.lapsed += 1;
  }
  return result;
}
