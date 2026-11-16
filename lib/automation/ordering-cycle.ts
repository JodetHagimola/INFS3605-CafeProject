import "server-only";

import { draftOrderInsertSchema } from "@/lib/agent/draft-schema";
import { inventoryClient } from "@/lib/inventory/server";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import { calculateOrderingPlan, type IncomingQuantity, type ReorderRule, type SupplierQuote } from "./ordering-cycle-model";
import { deterministicDeliveryId, sydneyDate } from "./delivery-cycle-model";

type Row = Record<string, unknown>;

function rowValue(value: unknown, field: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The ordering preview returned an invalid ${field}.`);
  }
  return value as Row;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`The ordering preview is missing ${field}.`);
  }
  return value.trim();
}

function decimal(value: unknown, field: string, nullable = false): string | null {
  if (value == null && nullable) return null;
  const parsed = typeof value === "number" ? String(value) : value;
  if (typeof parsed !== "string" || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(parsed)) {
    throw new Error(`The ordering preview received an invalid ${field}.`);
  }
  return parsed;
}

function amount(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`The ordering preview received an invalid ${field}.`);
  return parsed;
}

function quantityMicros(value: string, field: string): bigint {
  const [whole, fraction = ""] = value.split(".");
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`The ordering preview received an invalid ${field}.`);
  }
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}

function formatMicros(value: bigint): string {
  const whole = value / BigInt(1_000_000);
  const fraction = (value % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

async function readAll(table: string, columns: string, order: string): Promise<Row[]> {
  const rows: Row[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await inventoryClient()
      .from(table)
      .select(columns)
      .order(order)
      .range(offset, offset + 499);
    if (error) throw new Error(`Could not read ${table} for ordering preview: ${error.message}`);
    rows.push(...data.map((value) => rowValue(value, table)));
    if (data.length < 500) return rows;
  }
}

function money(cents: number): string {
  return (cents / 100).toFixed(2);
}

function startOfWeek(date: string): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  const day = new Date(timestamp).getUTCDay();
  const mondayOffset = (day + 6) % 7;
  return new Date(timestamp - mondayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function asSydneyDate(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`The ordering preview received an invalid ${field}.`);
  }
  return sydneyDate(new Date(value));
}

type OrderingPlanItem = {
  ingredientId: string;
  ingredient: string;
  unit: string;
  currentStock: string | null;
  minimum: string | null;
  averageDailyUsage: string | null;
  incoming: IncomingQuantity[];
  rule: ReorderRule | null;
  plan: ReturnType<typeof calculateOrderingPlan>;
};

export async function runOrderingPreview(now = new Date()): Promise<{
  status: "paused" | "blocked_email_mode" | "preview_only";
  date: string;
  plans: OrderingPlanItem[];
  policy: {
    autoOrderLimit: string;
    dailyLimit: string;
    weeklyLimit: string | null;
    committedTodayCents: number;
    committedThisWeekCents: number;
  } | null;
}> {
  if (!Number.isFinite(now.getTime())) throw new Error("Ordering preview time is invalid.");

  const db = inventoryClient();
  const { data: settings, error: settingsError } = await db
    .from("cafe_settings")
    .select("automation_paused,email_mode")
    .eq("id", 1)
    .single();
  if (settingsError || !settings) {
    throw new Error(`Could not read ordering settings: ${settingsError?.message ?? "No settings row returned"}`);
  }
  const today = sydneyDate(now);
  if (settings.automation_paused === true) return { status: "paused", date: today, plans: [], policy: null };
  if (settings.email_mode !== "test") return { status: "blocked_email_mode", date: today, plans: [], policy: null };

  const since = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000).toISOString();
  const weekStart = startOfWeek(today);
  const [inventory, ingredients, priceRows, suppliers, ruleRows, incomingRows, usageResult, policyResult, orderRows, cycleRows] =
    await Promise.all([
      readAll("inventory", "ingredient_id,quantity_in_stock,minimum_stock", "ingredient_id"),
      readAll("ingredients", "ingredient_id,ingredient_name,unit", "ingredient_id"),
      readAll("supplier_prices", "supplier,ingredient_id,price,minimum_order,pack_size,pack_label,lead_time_days", "ingredient_id"),
      readAll("suppliers", "name,contact_email,lead_time_days,active", "name"),
      readAll("cafe_reorder_rules", "ingredient_id,supplier,packs,order_limit,enabled", "ingredient_id"),
      readAll("open_delivery_balances", "delivery_id,ingredient_id,outstanding_quantity,expected_date", "delivery_id"),
      db.from("inventory_sale_ingredients")
        .select("ingredient_id,amount,inventory_sales!inner(created_at)")
        .gte("inventory_sales.created_at", since),
      db.from("cafe_spend_policy")
        .select("auto_order_limit,daily_limit,weekly_limit")
        .eq("id", 1)
        .single(),
      readAll("cafe_sim_orders", "total,status,submitted_at", "created_at"),
      readAll("cafe_ordering_cycles", "status,plan,created_at", "created_at"),
    ]);

  if (usageResult.error) throw new Error(`Could not read recent ingredient usage: ${usageResult.error.message}`);
  if (policyResult.error || !policyResult.data) {
    throw new Error(`Could not read ordering spend policy: ${policyResult.error?.message ?? "No policy row returned"}`);
  }

  const ingredientById = new Map(ingredients.map((row) => [String(row.ingredient_id), row]));
  const inventoryById = new Map(inventory.map((row) => [String(row.ingredient_id), row]));
  const supplierByName = new Map(suppliers.map((row) => [text(row.name, "supplier name"), row]));
  const ruleByIngredient = new Map(ruleRows.map((row) => [String(row.ingredient_id), row]));
  const usageByIngredient = new Map<string, bigint>();
  for (const value of usageResult.data ?? []) {
    const row = rowValue(value, "recent ingredient usage");
    const id = String(row.ingredient_id);
    const quantity = decimal(row.amount, "usage quantity");
    if (quantity === null) throw new Error("Recent ingredient usage is missing a quantity.");
    usageByIngredient.set(
      id,
      (usageByIngredient.get(id) ?? BigInt(0)) + quantityMicros(quantity, "usage quantity"),
    );
  }
  const incomingByIngredient = new Map<string, IncomingQuantity[]>();
  for (const row of incomingRows) {
    const id = String(row.ingredient_id);
    const entries = incomingByIngredient.get(id) ?? [];
    if (typeof row.expected_date !== "string") {
      throw new Error("The ordering preview received an invalid incoming expected date.");
    }
    entries.push({
      quantity: text(decimal(row.outstanding_quantity, "incoming quantity"), "incoming quantity"),
      expectedDate: text(row.expected_date.slice(0, 10), "incoming expected date"),
    });
    incomingByIngredient.set(id, entries);
  }

  let committedTodayCents = 0;
  let committedThisWeekCents = 0;
  for (const row of orderRows) {
    if (row.status !== "submitted" || row.submitted_at == null) continue;
    const submitted = asSydneyDate(row.submitted_at, "submitted order date");
    const total = Math.round(amount(row.total, "submitted order total") * 100);
    if (submitted === today) committedTodayCents += total;
    if (submitted >= weekStart && submitted <= today) committedThisWeekCents += total;
  }
  for (const row of cycleRows) {
    if (row.status !== "simulated_order") continue;
    const submitted = asSydneyDate(row.created_at, "simulated order date");
    const plan = rowValue(row.plan, "saved ordering cycle plan");
    const total = Math.round(amount(plan.totalCents, "simulated order total"));
    if (submitted === today) committedTodayCents += total;
    if (submitted >= weekStart && submitted <= today) committedThisWeekCents += total;
  }

  const pricesByIngredient = new Map<string, SupplierQuote[]>();
  for (const row of priceRows) {
    const supplierName = text(row.supplier, "supplier price supplier");
    const supplier = supplierByName.get(supplierName);
    const leadTime = supplier?.lead_time_days ?? row.lead_time_days;
    if (leadTime == null || !Number.isInteger(Number(leadTime))) {
      throw new Error(`A valid lead time is missing for ${supplierName}.`);
    }
    const quote: SupplierQuote = {
      supplier: supplierName,
      price: text(decimal(row.price, "supplier price"), "supplier price"),
      minimumOrder: text(decimal(row.minimum_order, "supplier minimum order"), "supplier minimum order"),
      packSize: text(decimal(row.pack_size, "supplier pack size"), "supplier pack size"),
      packLabel: typeof row.pack_label === "string" && row.pack_label.trim() ? row.pack_label.trim() : null,
      leadTimeDays: Number(leadTime),
      active: supplier?.active === true,
      contactEmail: typeof supplier?.contact_email === "string" ? supplier.contact_email : null,
    };
    const id = String(row.ingredient_id);
    const quotes = pricesByIngredient.get(id) ?? [];
    quotes.push(quote);
    pricesByIngredient.set(id, quotes);
  }

  const policy = policyResult.data;
  const autoOrderLimit = text(decimal(policy.auto_order_limit, "automatic order limit"), "automatic order limit");
  const dailyLimit = text(decimal(policy.daily_limit, "daily spending limit"), "daily spending limit");
  const weeklyLimit = decimal(policy.weekly_limit, "weekly spending limit", true);
  const plans: OrderingPlanItem[] = [];
  for (const ingredient of ingredients) {
    const ingredientId = String(ingredient.ingredient_id);
    const stockRow = inventoryById.get(ingredientId);
    const ruleRow = ruleByIngredient.get(ingredientId);
    const rule: ReorderRule | null = ruleRow ? {
      supplier: text(ruleRow.supplier, "preferred supplier"),
      packs: Number(ruleRow.packs),
      orderLimit: text(decimal(ruleRow.order_limit, "reorder rule order limit"), "reorder rule order limit"),
      enabled: ruleRow.enabled === true,
    } : null;
    const usage = usageByIngredient.get(ingredientId);
    const averageDailyUsage = usage === undefined
      ? null
      : formatMicros((usage + BigInt(27)) / BigInt(28));
    const currentStock = decimal(stockRow?.quantity_in_stock, "current stock", true);
    const minimum = decimal(stockRow?.minimum_stock, "minimum stock", true);
    const incoming = incomingByIngredient.get(ingredientId) ?? [];
    const plan = calculateOrderingPlan({
      today,
      stock: currentStock,
      minimum,
      averageDailyUsage,
      incoming,
      quotes: pricesByIngredient.get(ingredientId) ?? [],
      rule,
      autoOrderLimit,
      dailyLimit,
      weeklyLimit,
      committedToday: money(committedTodayCents),
      committedThisWeek: money(committedThisWeekCents),
    });
    plans.push({
      ingredientId,
      ingredient: text(ingredient.ingredient_name, "ingredient name"),
      unit: text(ingredient.unit, "ingredient unit"),
      currentStock,
      minimum,
      averageDailyUsage,
      incoming,
      rule,
      plan,
    });
  }

  return {
    status: "preview_only",
    date: today,
    plans,
    policy: {
      autoOrderLimit,
      dailyLimit,
      weeklyLimit,
      committedTodayCents,
      committedThisWeekCents,
    },
  };
}

function daysBetween(start: string, end: string): number {
  const startTime = Date.parse(`${start}T00:00:00.000Z`);
  const endTime = Date.parse(`${end}T00:00:00.000Z`);
  return Math.round((endTime - startTime) / (24 * 60 * 60 * 1000));
}

function policyCents(value: string, field: string): number {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${field} is not a valid monetary amount.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is too large.`);
  return Number(cents);
}

function numericValue(value: string | null, field: string): number {
  if (value === null) throw new Error(`${field} is unavailable.`);
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0) throw new Error(`${field} is invalid.`);
  return result;
}

export async function runOrderingCycle(now = new Date()): Promise<{
  status: "paused" | "blocked_email_mode" | "completed";
  date: string;
  evaluated: number;
  noAction: number;
  approvals: number;
  simulatedOrders: number;
  blocked: number;
}> {
  if (!inventoryWritesEnabled()) throw new Error("Inventory and order writes are disabled by server policy.");
  const preview = await runOrderingPreview(now);
  const result = {
    status: "completed" as const,
    date: preview.date,
    evaluated: preview.plans.length,
    noAction: 0,
    approvals: 0,
    simulatedOrders: 0,
    blocked: 0,
  };
  if (preview.status === "paused") return { ...result, status: "paused" };
  if (preview.status === "blocked_email_mode") return { ...result, status: "blocked_email_mode" };
  if (!preview.policy) throw new Error("Ordering policy was not loaded.");

  const db = inventoryClient();
  await resumeOrderingApprovals(db, now);
  const ordersBySupplier = new Map<string, OrderingPlanItem[]>();
  const blockedItems: OrderingPlanItem[] = [];
  for (const item of preview.plans) {
    if (item.plan.status === "no_action") {
      result.noAction += 1;
    } else if (item.plan.status === "blocked") {
      blockedItems.push(item);
      result.blocked += 1;
    } else {
      const entries = ordersBySupplier.get(item.plan.candidate.supplier) ?? [];
      entries.push(item);
      ordersBySupplier.set(item.plan.candidate.supplier, entries);
    }
  }

  for (const item of blockedItems) {
    const cycleKey = `ingredient:${preview.date}:${item.ingredientId}`;
    const plan = {
      ingredientId: item.ingredientId,
      ingredient: item.ingredient,
      status: "blocked",
      flags: item.plan.status === "blocked" ? item.plan.flags : [],
    };
    const { error } = await db.from("cafe_ordering_cycles").upsert({
      cycle_key: cycleKey,
      supplier: null,
      status: "blocked",
      plan,
      updated_at: now.toISOString(),
    }, { onConflict: "cycle_key" });
    if (error) throw new Error(`Could not record blocked ordering data for ${item.ingredient}: ${error.message}`);
    const notification = await db.from("owner_notifications").upsert({
      severity: "decision",
      title: `Ordering needs review: ${item.ingredient}`,
      body: plan.flags.join(" "),
      surface_after: now.toISOString(),
      channel: "in_app",
      status: "pending",
      dedupe_key: `ordering-blocked:${preview.date}:${item.ingredientId}`,
    }, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (notification.error) {
      throw new Error(`Could not notify the owner about blocked ordering data: ${notification.error.message}`);
    }
  }

  let committedTodayCents = preview.policy.committedTodayCents;
  let committedThisWeekCents = preview.policy.committedThisWeekCents;
  for (const [supplier, items] of [...ordersBySupplier.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const cycleKey = `supplier:${preview.date}:${supplier}`;
    const draftId = deterministicDeliveryId("ordering-draft", preview.date, supplier);
    const approvalId = deterministicDeliveryId("ordering-approval", preview.date, supplier);
    const mailEventId = deterministicDeliveryId("ordering-email", preview.date, supplier);
    const reference = `BRW-${preview.date.replaceAll("-", "")}-${deterministicDeliveryId(supplier).slice(0, 8).toUpperCase()}`;
    const lines = items.map((item) => {
      const candidate = item.plan.status === "order" ? item.plan.candidate : null;
      if (!candidate) throw new Error("An ordering supplier group contains a non-order plan.");
      const leadDays = daysBetween(preview.date, candidate.expectedDate);
      const incomingByDate = formatMicros(item.incoming
        .filter((entry) => entry.expectedDate <= candidate.expectedDate)
        .reduce((sum, entry) => sum + quantityMicros(entry.quantity, "incoming quantity"), BigInt(0)));
      const stock = numericValue(item.currentStock, "current stock");
      const minimum = numericValue(item.minimum, "minimum stock");
      const average = numericValue(item.averageDailyUsage, "average daily usage");
      return {
        ingredientId: item.ingredientId,
        ingredient: item.ingredient,
        unit: item.unit,
        currentStock: stock,
        minimum,
        averageDailyUsage: average,
        incomingByDate,
        candidate,
        leadDays,
        requiredQuantity: minimum + average * leadDays,
      };
    });
    const totalCents = lines.reduce((sum, line) => sum + line.candidate.totalCents, 0);
    if (!Number.isSafeInteger(totalCents)) throw new Error("The grouped supplier order total is too large.");
    const flags = [...new Set(lines.flatMap((line) =>
      line.candidate.flags.map((flag) => `${line.ingredient}: ${flag}`),
    ))];
    if (totalCents > policyCents(preview.policy.autoOrderLimit, "Automatic order limit")) {
      flags.push("Grouped supplier order exceeds the automatic per-order limit.");
    }
    if (committedTodayCents + totalCents > policyCents(preview.policy.dailyLimit, "Daily spending limit")) {
      flags.push("Grouped supplier order would exceed the daily spending limit.");
    }
    if (preview.policy.weeklyLimit !== null
      && committedThisWeekCents + totalCents > policyCents(preview.policy.weeklyLimit, "Weekly spending limit")) {
      flags.push("Grouped supplier order would exceed the weekly spending limit.");
    }
    const autoEligible = flags.length === 0;
    const expectedDate = lines.reduce(
      (latest, line) => line.candidate.expectedDate > latest ? line.candidate.expectedDate : latest,
      lines[0].candidate.expectedDate,
    );
    const cyclePlan = {
      date: preview.date,
      supplier,
      reference,
      totalCents,
      expectedDate,
      autoEligible,
      flags,
      lines: lines.map((line) => ({
        ingredientId: line.ingredientId,
        ingredient: line.ingredient,
        unit: line.unit,
        currentStock: String(line.currentStock),
        minimum: String(line.minimum),
        incomingByDate: String(line.incomingByDate),
        packs: line.candidate.packs,
        packSize: line.candidate.packSize,
        packLabel: line.candidate.packLabel,
        quantity: line.candidate.stockAmount,
        unitPrice: line.candidate.unitPrice,
        minimumOrder: line.candidate.minimumOrder,
        totalCents: line.candidate.totalCents,
        expectedDate: line.candidate.expectedDate,
        leadDays: line.leadDays,
      })),
    };
    const draftLines = lines.map((line) => ({
      ingredientId: line.ingredientId,
      ingredient: line.ingredient,
      requiredQuantity: line.requiredQuantity,
      currentStock: line.currentStock,
      incomingStock: numericValue(line.incomingByDate, "incoming quantity"),
      recommendedOrderQuantity: numericValue(line.candidate.stockAmount, "recommended order quantity"),
      expectedDate: line.candidate.expectedDate,
      packCount: line.candidate.packs,
      packSize: numericValue(line.candidate.packSize, "supplier pack size"),
      packLabel: line.candidate.packLabel,
      totalCents: line.candidate.totalCents,
      unit: line.unit,
      recommendedSupplier: {
        supplier,
        price: numericValue(line.candidate.unitPrice, "supplier price"),
        deliveryTime: `${line.leadDays} day(s)`,
        minimumOrder: numericValue(line.candidate.minimumOrder, "supplier minimum order"),
      },
      alternativeSupplier: null,
      reason: `Projected demand through ${line.candidate.expectedDate} leaves stock below the minimum. The suggestion uses ${line.candidate.packs} whole pack(s).`,
    }));
    const draftInput = draftOrderInsertSchema.safeParse({
      status: autoEligible ? "approved" : "draft",
      forecastDate: preview.date,
      forecast: {
        forecastDate: preview.date,
        endDate: expectedDate,
        isPublicHoliday: null,
        predictedSales: {},
        source: "ordering_cycle",
      },
      lines: draftLines,
      flags,
      dataUsed: {
        recipes: [],
        inventory: lines.map((line) => ({
          ingredientId: line.ingredientId,
          quantity: line.currentStock,
          lastUpdated: null,
        })),
        deliveries: lines.flatMap((line) => items.find((item) => item.ingredientId === line.ingredientId)?.incoming.map((entry) => ({
          ingredientId: line.ingredientId,
          quantity: numericValue(entry.quantity, "incoming quantity"),
          expectedDate: entry.expectedDate,
        })) ?? []),
        receipts: [],
        supplierPrices: lines.map((line) => ({
          supplier,
          ingredientId: line.ingredientId,
          price: numericValue(line.candidate.unitPrice, "supplier price"),
          deliveryTime: `${line.leadDays} day(s)`,
          minimumOrder: numericValue(line.candidate.minimumOrder, "supplier minimum order"),
          packSize: numericValue(line.candidate.packSize, "supplier pack size"),
          packLabel: line.candidate.packLabel,
        })),
      },
    });
    if (!draftInput.success) {
      throw new Error("The ordering draft did not pass validation and was not saved.");
    }
    const applicationPlan = {
      ...cyclePlan,
      draft: draftInput.data,
      mailFacts: {
        kind: "order",
        reference,
        supplier,
        totalCents,
        lines: cyclePlan.lines,
      },
    };
    const applied = await db.rpc("apply_cafe_ordering_cycle", {
      p_cycle_key: cycleKey,
      p_supplier: supplier,
      p_draft_id: draftId,
      p_approval_id: approvalId,
      p_email_event_id: mailEventId,
      p_auto_eligible: autoEligible,
      p_plan: applicationPlan,
    });
    if (applied.error || !applied.data) {
      throw new Error(`Could not persist the ordering decision: ${applied.error?.message ?? "No decision returned"}`);
    }
    const appliedStatus = text(rowValue(applied.data, "ordering-cycle result").status, "ordering-cycle status");
    if (appliedStatus === "paused") return { ...result, status: "paused" };
    if (appliedStatus === "approval_required") result.approvals += 1;
    else if (appliedStatus === "simulated_order") result.simulatedOrders += 1;
    else if (appliedStatus === "blocked") result.blocked += 1;
    else throw new Error(`The ordering cycle returned an unknown status: ${appliedStatus}`);
  }

  return result;
}

async function recordOrderingActivity(outcome: "success" | "blocked", reason: string): Promise<void> {
  const { error } = await inventoryClient().from("agent_activity").insert({
    tool: "ordering_cycle",
    input_summary: "Scheduled test-mode supplier ordering cycle",
    outcome,
    reason: reason.slice(0, 1000),
    trigger: "ordering_cycle",
  });
  if (error) throw new Error(`Could not log the ordering-cycle activity: ${error.message}`);
}

async function registerOrderingDelivery(
  db: ReturnType<typeof inventoryClient>,
  input: {
    draftId: string;
    expectedDate: string;
    reference: string;
    now: Date;
    cycleKey: string;
    supplier: string;
    totalCents: number;
    lines: Array<Record<string, unknown>>;
    emailEventId: string;
  },
): Promise<{ batchId: string }> {
  const { data, error } = await db.rpc("register_order_delivery", {
    p_draft_id: input.draftId,
    p_expected_date: input.expectedDate,
    p_reference: input.reference,
  });
  if (error || !data) throw new Error(`Could not register the simulated supplier delivery: ${error?.message ?? "No result returned"}`);
  const batchId = text(rowValue(data, "registered delivery").batch_id, "registered batch ID");
  const deliveries = await db.from("incoming_deliveries")
    .select("delivery_id,ingredient_id,expected_date")
    .eq("batch_id", batchId)
    .order("ingredient_id");
  if (deliveries.error || !deliveries.data?.length) {
    throw new Error(`Could not verify simulated deliveries: ${deliveries.error?.message ?? "No deliveries returned"}`);
  }
  const deliveryByIngredient = new Map(deliveries.data.map((delivery) => [
    String(delivery.ingredient_id),
    { deliveryId: String(delivery.delivery_id), expectedDate: String(delivery.expected_date).slice(0, 10) },
  ]));
  const mailFacts = {
    kind: "order",
    reference: input.reference,
    supplier: input.supplier,
    totalCents: input.totalCents,
    lines: input.lines.map((line) => {
      const ingredientId = text(line.ingredientId, "order ingredient ID");
      const delivery = deliveryByIngredient.get(ingredientId);
      if (!delivery) throw new Error(`No simulated delivery was returned for ingredient ${ingredientId}.`);
      return { ...line, ...delivery };
    }),
  };
  const mail = await db.from("cafe_test_mail").upsert({
    event_id: input.emailEventId,
    delivery_id: null,
    purpose: "order_confirmation",
    attempt: 1,
    facts: mailFacts,
    payload: null,
    channel: null,
    status: "queued",
    retry_at: input.now.toISOString(),
    dedupe_key: `order-confirmation:${input.cycleKey}`,
  }, { onConflict: "dedupe_key", ignoreDuplicates: true });
  if (mail.error) throw new Error(`Could not queue the supplier test email: ${mail.error.message}`);
  const notification = await db.from("owner_notifications").upsert({
    severity: "info",
    title: `Simulated order registered for ${input.supplier}`,
    body: `Order ${input.reference} for $${(input.totalCents / 100).toFixed(2)} was recorded and its supplier email was queued for test-mode delivery. No supplier was contacted.`,
    surface_after: input.now.toISOString(),
    channel: "in_app",
    status: "pending",
    dedupe_key: `ordering-simulated:${input.cycleKey}`,
  }, { onConflict: "dedupe_key", ignoreDuplicates: true });
  if (notification.error) throw new Error(`Could not notify the owner about the simulated order: ${notification.error.message}`);
  await recordOrderingActivity("success", `Simulated order ${input.reference} was registered for ${input.supplier}; supplier email is queued for test mode only.`);
  return { batchId };
}

export async function finishOrderingApproval(
  approvalId: string,
  decision: "approved" | "rejected",
  now = new Date(),
): Promise<void> {
  const db = inventoryClient();
  const approvalResult = await db.from("approval_inbox")
    .select("id,status,details")
    .eq("id", approvalId)
    .maybeSingle();
  if (approvalResult.error || !approvalResult.data) {
    throw new Error(`Could not load the ordering approval: ${approvalResult.error?.message ?? "No approval returned"}`);
  }
  const details = rowValue(approvalResult.data.details, "ordering approval details");
  if (typeof details.orderingCycleKey !== "string") return;
  const cycleKey = details.orderingCycleKey;
  const cycleResult = await db.from("cafe_ordering_cycles")
    .select("cycle_key,status,draft_id,plan")
    .eq("cycle_key", cycleKey)
    .maybeSingle();
  if (cycleResult.error || !cycleResult.data) {
    throw new Error(`Could not load the ordering cycle: ${cycleResult.error?.message ?? "No cycle returned"}`);
  }
  if (cycleResult.data.status === "simulated_order") return;
  if (cycleResult.data.status !== "approval_required") return;
  if (approvalResult.data.status !== decision) return;

  if (decision === "rejected") {
    const updated = await db.from("cafe_ordering_cycles")
      .update({ status: "blocked", updated_at: now.toISOString() })
      .eq("cycle_key", cycleKey);
    if (updated.error) throw new Error(`Could not record the rejected order decision: ${updated.error.message}`);
    await recordOrderingActivity("blocked", `The owner rejected the proposed test-mode order ${cycleKey}.`);
    return;
  }

  if (!inventoryWritesEnabled()) {
    await recordOrderingActivity(
      "blocked",
      `Owner approval ${approvalId} was recorded, but order registration is disabled by server policy. No supplier was contacted.`,
    );
    return;
  }

  const current = await runOrderingPreview(now);
  if (current.status !== "preview_only") {
    throw new Error("Ordering remains paused or outside test email mode; the approved order was not registered.");
  }
  const draftId = text(cycleResult.data.draft_id, "approved ordering draft ID");
  const draftResult = await db.from("draft_orders")
    .select("id,status,lines")
    .eq("id", draftId)
    .maybeSingle();
  if (draftResult.error || !draftResult.data) {
    throw new Error(`Could not load the approved ordering draft: ${draftResult.error?.message ?? "No draft returned"}`);
  }
  if (!Array.isArray(draftResult.data.lines) || !draftResult.data.lines.length) {
    throw new Error("The approved ordering draft contains no lines.");
  }
  const lines = draftResult.data.lines.map((value) => rowValue(value, "approved order line"));
  const validationFlags: string[] = [];
  for (const line of lines) {
    const ingredientId = text(line.ingredientId, "approved ingredient ID");
    const supplierChoice = rowValue(line.recommendedSupplier, "approved supplier choice");
    const supplier = text(supplierChoice.supplier, "approved supplier");
    const currentItem = current.plans.find((item) => item.ingredientId === ingredientId);
    if (!currentItem || currentItem.plan.status !== "order") {
      validationFlags.push(`The current stock projection no longer recommends an order for ${ingredientId}.`);
      continue;
    }
    const candidate = currentItem.plan.candidate;
    if (candidate.supplier !== supplier
      || candidate.stockAmount !== String(line.recommendedOrderQuantity)
      || Number(candidate.unitPrice) !== Number(supplierChoice.price)
      || candidate.expectedDate !== line.expectedDate
      || !candidate.active
      || !candidate.hasContact) {
      validationFlags.push(`Stock, price, lead time, supplier status, or contact changed for ${currentItem.ingredient}.`);
    }
  }
  if (validationFlags.length) {
    const updated = await db.from("cafe_ordering_cycles")
      .update({ status: "blocked", updated_at: now.toISOString() })
      .eq("cycle_key", cycleKey);
    if (updated.error) throw new Error(`Could not record a stale approval: ${updated.error.message}`);
    const notification = await db.from("owner_notifications").upsert({
      severity: "decision",
      title: "Approved order needs a fresh review",
      body: validationFlags.join(" "),
      surface_after: now.toISOString(),
      channel: "in_app",
      status: "pending",
      dedupe_key: `ordering-stale-approval:${cycleKey}`,
    }, { onConflict: "dedupe_key", ignoreDuplicates: true });
    if (notification.error) throw new Error(`Could not notify the owner about the stale order: ${notification.error.message}`);
    return;
  }

  if (draftResult.data.status !== "approved") {
    const updated = await db.from("draft_orders")
      .update({ status: "approved", approved_at: now.toISOString() })
      .eq("id", draftId)
      .eq("status", "draft")
      .select("id")
      .maybeSingle();
    if (updated.error || !updated.data) {
      throw new Error(`Could not mark the approved order draft: ${updated.error?.message ?? "Draft was not updated"}`);
    }
  }

  const storedPlan = rowValue(cycleResult.data.plan, "ordering cycle plan");
  const cycleLines = Array.isArray(storedPlan.lines)
    ? storedPlan.lines.map((value) => rowValue(value, "ordering cycle line"))
    : [];
  const expectedDate = text(storedPlan.expectedDate, "ordering expected date");
  const reference = text(storedPlan.reference, "ordering reference");
  const supplier = text(storedPlan.supplier, "ordering supplier");
  const totalCents = amount(storedPlan.totalCents, "ordering total");
  const emailEventId = deterministicDeliveryId("ordering-email", cycleKey);
  const registered = await registerOrderingDelivery(db, {
    draftId,
    expectedDate,
    reference,
    now,
    cycleKey,
    supplier,
    totalCents,
    lines: cycleLines,
    emailEventId,
  });
  const updated = await db.from("cafe_ordering_cycles").update({
    status: "simulated_order",
    batch_id: registered.batchId,
    email_event_id: emailEventId,
    updated_at: now.toISOString(),
  }).eq("cycle_key", cycleKey);
  if (updated.error) throw new Error(`Could not finish the approved ordering cycle: ${updated.error.message}`);
}

async function resumeOrderingApprovals(db: ReturnType<typeof inventoryClient>, now: Date): Promise<void> {
  const { data: cycles, error } = await db.from("cafe_ordering_cycles")
    .select("cycle_key,approval_id")
    .eq("status", "approval_required")
    .not("approval_id", "is", null)
    .order("created_at")
    .limit(100);
  if (error) throw new Error(`Could not read order approvals to resume: ${error.message}`);
  for (const cycle of cycles ?? []) {
    const approvalId = text(cycle.approval_id, "approval ID");
    const approval = await db.from("approval_inbox").select("status").eq("id", approvalId).maybeSingle();
    if (approval.error) throw new Error(`Could not read an order approval: ${approval.error.message}`);
    if (approval.data?.status === "approved" || approval.data?.status === "rejected") {
      await finishOrderingApproval(approvalId, approval.data.status, now);
    }
  }
}
