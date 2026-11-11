import { withConsistentBrief } from "./brief-freshness";
import "server-only";

import { randomUUID } from "node:crypto";
import { generateText, Output } from "ai";
import { inventoryClient } from "@/lib/inventory/server";
import { createRestockApproval } from "./approval";
import { isValidISODate } from "./date";
import {
  calculateRestockSuggestion,
  calculateStockAttention,
  calculateTrafficForecast,
  trafficHeadline,
  type BriefSalesRow,
  type RestockSuggestion,
  type StockAttention,
  type SupplierOffer,
  type TrafficForecast,
} from "./brief-calculations";
import {
  dailyBriefOutputSchema,
  dailyBriefSchema,
  type DailyBrief,
  type DailyBriefStockItem,
} from "./brief-schema";
import { getGeminiModel } from "./model";

type DataRow = Record<string, unknown>;

const BRIEF_SELECT = "brief_date,greeting,status_line,items,all_clear,details";
const PAGE_SIZE = 500;
const CACHE_SCHEMA_VERSION = 5;

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function redactedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "******")
    .replace(/(api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
    .slice(0, 1500);
}

function logStageError(stage: string, error: unknown): void {
  console.error(`Today's brief ${stage} failed:`, {
    name: error instanceof Error ? error.name : "UnknownError",
    message: redactedError(error),
    ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
  });
}

function addWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning) && warnings.length < 20) warnings.push(warning);
}

function parseNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim()
      ? Number(value)
      : NaN;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} contains an invalid quantity.`);
  return parsed;
}

function parseText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is missing.`);
  return value.trim();
}

function parseDate(value: unknown, label: string): string {
  const date = parseText(value, label);
  if (!isValidISODate(date)) throw new Error(`${label} contains an invalid date.`);
  return date;
}

function sydneyDate(value: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) throw new Error("A delivery receipt has an invalid timestamp.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

async function readRows(
  db: ReturnType<typeof inventoryClient>,
  table: string,
  columns: string,
  orderBy: string[],
  dateRange?: { column: string; from: string; to: string },
): Promise<DataRow[]> {
  const rows: DataRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    let query = db.from(table).select(columns);
    if (dateRange) query = query.gte(dateRange.column, dateRange.from).lt(dateRange.column, dateRange.to);
    for (const column of orderBy) query = query.order(column);
    const { data, error } = await query.range(offset, offset + PAGE_SIZE - 1);
    if (error) throw error;
    rows.push(...(data as unknown as DataRow[]));
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function readApprovedRestocks(
  db: ReturnType<typeof inventoryClient>,
  date: string,
): Promise<DataRow[]> {
  const { data, error } = await db.from("approval_inbox")
    .select("details")
    .eq("action", "place_or_send_order")
    .eq("status", "approved")
    .contains("details", { briefDate: date });
  if (error) throw error;
  return (data ?? []) as unknown as DataRow[];
}

async function readSection<T>(
  name: string,
  warnings: string[],
  task: () => Promise<T>,
): Promise<T | null> {
  try {
    return await task();
  } catch (error) {
    logStageError(`data fetch (${name})`, error);
    addWarning(warnings, `I couldn't check ${name} today.`);
    return null;
  }
}

function parseSalesRows(rows: DataRow[]): BriefSalesRow[] {
  return rows.map((row) => {
    const salesDate = parseDate(row.sales_date, "Sales date");
    const productName = parseText(row.product_name, "Sales product");
    const unitsSold = parseNumber(row.units_sold, "Sales quantity");
    if (!Number.isSafeInteger(unitsSold)) throw new Error(`Sales quantity for ${productName} is not a whole number.`);
    if (typeof row.is_public_holiday !== "boolean") {
      throw new Error(`The public-holiday value for ${salesDate} is invalid.`);
    }
    return { salesDate, productName, unitsSold, isPublicHoliday: row.is_public_holiday };
  });
}

function holidayLabel(date: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    weekday: "long",
    timeZone: "Australia/Sydney",
  }).format(new Date(`${date}T12:00:00.000Z`));
}

async function generateGreeting(input: {
  date: string;
  traffic: TrafficForecast | null;
  stock: StockAttention[];
  warnings: string[];
}): Promise<{ greeting: string; warning?: string }> {
  let rawOutput = "";
  try {
    const result = await generateText({
      model: getGeminiModel(),
      output: Output.object({ schema: dailyBriefOutputSchema }),
      instructions: "Write one warm, concise café-owner greeting. Do not invent facts, numbers, dates, stock levels, or actions. Return only the required object.",
      prompt: JSON.stringify({
        date: input.date,
        weekday: holidayLabel(input.date),
        traffic: input.traffic
          ? {
            label: input.traffic.label,
            expected: input.traffic.expected,
            low: input.traffic.low,
            high: input.traffic.high,
          }
          : null,
        stockAttention: input.stock.slice(0, 3).map(({ ingredient, status }) => ({ ingredient, status })),
        dataWarnings: input.warnings,
      }),
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(12_000),
    });
    rawOutput = result.text;
    if (!result.output) throw new Error("The model returned no greeting matching the brief schema.");
    return { greeting: result.output.greeting };
  } catch (error) {
    logStageError("model narration", error);
    if (rawOutput) console.error("Today's brief invalid model output:", rawOutput.slice(0, 1000));
    return {
      greeting: "Good morning.",
      warning: "I couldn't personalize the greeting; the data-based brief is still available.",
    };
  }
}

function toBrief(input: {
  date: string;
  greeting: string;
  traffic: TrafficForecast | null;
  holidayName: string | null;
  stock: StockAttention[];
  stockItems: DailyBriefStockItem[];
  warnings: string[];
}): DailyBrief {
  const stockCheckIncomplete = input.warnings.some((warning) =>
    /couldn't check|couldn't calculate|couldn't project|no inventory record|missing stock|stale or missing update|recipe is missing/i.test(warning),
  );
  const approvedIds = new Set(input.stockItems
    .filter((item) => /restock (?:was )?(?:auto-)?approved/i.test(item.headline))
    .map((item) => item.ingredient_id));
  const approvedNames = input.stockItems
    .filter((item) => approvedIds.has(item.ingredient_id))
    .map((item) => item.name);
  const pendingStock = input.stock.filter((item) => !approvedIds.has(item.ingredientId));
  const itemNames = pendingStock.slice(0, 3).map((item) => item.ingredient).join(", ");
  const approvedSummary = approvedNames.length > 0
    ? `${approvedNames.length} restock${approvedNames.length === 1 ? "" : "s"} approved.`
    : "";
  const approvedDetails = approvedNames.length > 0
    ? `Restock approved for ${approvedNames.join(", ")}.`
    : "";
  const allClear = pendingStock.length > 0
    ? `${pendingStock.length} stock item${pendingStock.length === 1 ? "" : "s"} need attention: ${itemNames}${pendingStock.length > 3 ? ` and ${pendingStock.length - 3} more` : ""}.${approvedDetails ? ` ${approvedDetails}` : ""}`.slice(0, 500)
    : approvedDetails || (stockCheckIncomplete
      ? "I couldn't check every ingredient today; see the note below."
      : "No ingredients need attention today.");
  const trafficUnavailable = input.warnings.some((warning) => warning.includes("public-holiday adjustment"))
    ? "I couldn't confirm public-holiday status, so today's traffic forecast is unavailable."
    : input.warnings.some((warning) => warning.includes("traffic forecast from the sales data"))
      ? "I couldn't check recent sales, so today's traffic forecast is unavailable."
      : `There's not enough recent sales history to forecast traffic for ${holidayLabel(input.date)}.`;
  const statusLine = pendingStock.length > 0
    ? `${pendingStock.length} thing${pendingStock.length === 1 ? "" : "s"} need you today.${approvedSummary ? ` ${approvedSummary}` : ""}`
    : approvedSummary || (stockCheckIncomplete
      ? "Today's stock check is incomplete."
      : "No stock issues need your attention today.");
  return dailyBriefSchema.parse({
    greeting: input.greeting,
    status_line: statusLine,
    traffic: {
      label: input.traffic?.label ?? null,
      headline: input.traffic ? trafficHeadline(input.traffic) : trafficUnavailable,
      expected_drinks: input.traffic?.expected ?? null,
      low: input.traffic?.low ?? null,
      high: input.traffic?.high ?? null,
      ...(input.traffic && input.holidayName
        ? { note: `NSW public holiday: ${input.holidayName}; forecast adjusted down 20%.` }
        : {}),
    },
    stock_items: input.stockItems,
    all_clear: allClear,
    data_warnings: input.warnings,
  });
}

function stockHeadline(item: StockAttention): string {
  return item.quantity < item.minimum
    ? `${item.ingredient} is running low.`
    : `${item.ingredient} may run short today.`;
}

function matchingStandingRule(
  rules: DataRow[] | null,
  ingredientId: string,
  supplier: string,
  total: number,
): { id: string; name: string; maximumTotal: number } | null {
  for (const rule of rules ?? []) {
    if (rule.enabled !== true
      || rule.supplier !== supplier
      || !Array.isArray(rule.ingredient_ids)
      || !rule.ingredient_ids.map(String).includes(ingredientId)) continue;
    const maximumTotal = Number(rule.maximum_total);
    if (!Number.isFinite(maximumTotal) || total > maximumTotal) continue;
    if (typeof rule.id !== "string" || typeof rule.name !== "string" || !rule.name.trim()) continue;
    return { id: rule.id, name: rule.name.trim(), maximumTotal };
  }
  return null;
}

function approvedRestockDetails(rows: DataRow[] | null): Map<string, Record<string, unknown>> {
  const approved = new Map<string, Record<string, unknown>>();
  for (const row of rows ?? []) {
    const details = row.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const record = details as Record<string, unknown>;
    if (typeof record.ingredientId === "string") approved.set(record.ingredientId, record);
  }
  return approved;
}

function markApprovedRestocks(
  brief: DailyBrief,
  approvals: ReadonlyMap<string, Record<string, unknown>>,
): DailyBrief {
  const newlyApprovedNames = brief.stock_items
    .filter((item) => approvals.has(item.ingredient_id) && !/restock was approved/i.test(item.headline))
    .map((item) => item.name);
  if (newlyApprovedNames.length === 0) return brief;

  const approvedNames = [...new Set(brief.stock_items
    .filter((item) => approvals.has(item.ingredient_id))
    .map((item) => item.name))];
  const remainingItems = brief.stock_items.filter((item) => !approvals.has(item.ingredient_id));
  const countMatch = brief.status_line.match(/^(\d+)/);
  const totalCount = countMatch ? Number(countMatch[1]) : brief.stock_items.length;
  const remainingCount = Math.max(0, totalCount - newlyApprovedNames.length);
  const approvedSummary = `${approvedNames.length} restock${approvedNames.length === 1 ? "" : "s"} approved.`;
  const approvedDetails = `Restock approved for ${approvedNames.join(", ")}.`;
  const statusLine = remainingCount > 0
    ? `${remainingCount} thing${remainingCount === 1 ? "" : "s"} need you today. ${approvedSummary}`
    : approvedDetails;
  const allClear = remainingCount > 0
    ? `${remainingCount} stock item${remainingCount === 1 ? "" : "s"} need attention: ${remainingItems.slice(0, 3).map((item) => item.name).join(", ")}.${remainingCount > 3 ? ` And ${remainingCount - 3} more.` : ""} ${approvedDetails}`.slice(0, 500)
    : approvedDetails;

  return dailyBriefSchema.parse({
    ...brief,
    status_line: statusLine,
    all_clear: allClear,
    stock_items: brief.stock_items.map((item) => approvals.has(item.ingredient_id)
      ? {
        ...item,
        headline: `${item.name} restock was approved today.`,
        why: "The restock was approved; no order was placed or supplier contacted.",
        suggested_order: {
          ...item.suggested_order,
          quantity: typeof approvals.get(item.ingredient_id)?.quantity === "number"
            ? Number(approvals.get(item.ingredient_id)?.quantity)
            : item.suggested_order.quantity,
          unit: typeof approvals.get(item.ingredient_id)?.unit === "string"
            ? String(approvals.get(item.ingredient_id)?.unit)
            : item.suggested_order.unit,
          supplier: typeof approvals.get(item.ingredient_id)?.supplier === "string"
            ? String(approvals.get(item.ingredient_id)?.supplier)
            : item.suggested_order.supplier,
          estimated_cost: typeof approvals.get(item.ingredient_id)?.estimatedCost === "number"
            ? Number(approvals.get(item.ingredient_id)?.estimatedCost)
            : item.suggested_order.estimated_cost,
        },
        approve_action_id: null,
      }
      : item),
  });
}

function approvedStockItem(
  item: StockAttention,
  note: string,
  suggestion: RestockSuggestion,
  storedDetails?: Record<string, unknown>,
): DailyBriefStockItem {
  const quantity = typeof storedDetails?.quantity === "number" ? storedDetails.quantity : suggestion.quantity;
  const unit = typeof storedDetails?.unit === "string" ? storedDetails.unit : suggestion.unit;
  const supplier = typeof storedDetails?.supplier === "string" ? storedDetails.supplier : suggestion.supplier;
  const estimatedCost = typeof storedDetails?.estimatedCost === "number"
    ? storedDetails.estimatedCost
    : suggestion.estimatedCost;
  return {
    ingredient_id: item.ingredientId,
    name: item.ingredient,
    headline: `${item.ingredient} restock was approved today.`,
    why: note.slice(0, 300),
    suggested_order: {
      quantity,
      unit,
      supplier,
      estimated_cost: estimatedCost,
    },
    approve_action_id: null,
  };
}

async function stockBriefItems(input: {
  date: string;
  stock: StockAttention[];
  incomingWithinThreeDays: ReadonlyMap<string, number>;
  incomingIsReliable: boolean;
  supplierOffers: ReadonlyMap<string, SupplierOffer[]>;
  standingRules: DataRow[] | null;
  approvedRestocks: Map<string, Record<string, unknown>>;
  warnings: string[];
}): Promise<DailyBriefStockItem[]> {
  const stockItems: DailyBriefStockItem[] = [];
  for (const item of input.stock.slice(0, 3)) {
    const suggestion = calculateRestockSuggestion({
      item,
      incomingWithinThreeDays: input.incomingWithinThreeDays.get(item.ingredientId) ?? 0,
      incomingIsReliable: input.incomingIsReliable,
      supplierOffers: input.supplierOffers.get(item.ingredientId) ?? [],
    });
    const existingApproval = input.approvedRestocks.get(item.ingredientId);
    if (existingApproval) {
      stockItems.push(approvedStockItem(
        item,
        "This restock was already approved today. No order was placed or supplier contacted.",
        suggestion,
        existingApproval,
      ));
      continue;
    }

    const actionId = randomUUID();
    const stockItem: DailyBriefStockItem = {
      ingredient_id: item.ingredientId,
      name: item.ingredient,
      headline: stockHeadline(item),
      why: item.status,
      suggested_order: {
        quantity: suggestion.quantity,
        unit: suggestion.unit,
        supplier: suggestion.supplier,
        estimated_cost: suggestion.estimatedCost,
      },
      approve_action_id: suggestion.quantity !== null
        && suggestion.quantity > 0
        && suggestion.supplier
        ? actionId
        : null,
    };
    const suggestedQuantity = suggestion.quantity;
    const supplier = suggestion.supplier;
    const rule = suggestedQuantity !== null
      && suggestedQuantity > 0
      && supplier
      && suggestion.estimatedCost !== null
      ? matchingStandingRule(input.standingRules, item.ingredientId, supplier, suggestion.estimatedCost)
      : null;
    if (rule && stockItem.approve_action_id && suggestedQuantity !== null && supplier) {
      try {
        const approval = await createRestockApproval({
          actionId,
          briefDate: input.date,
          ingredientId: item.ingredientId,
          ingredient: item.ingredient,
          quantity: suggestedQuantity,
          unit: suggestion.unit,
          supplier,
          reason: item.status,
          standingRule: rule,
        });
        input.approvedRestocks.set(item.ingredientId, {
          ingredientId: item.ingredientId,
          quantity: suggestedQuantity,
          unit: suggestion.unit,
          supplier,
          estimatedCost: approval.estimatedCost,
        });
        stockItems.push(approvedStockItem(
          item,
          approval.alreadyApproved
            ? "This restock was already approved today. No order was placed or supplier contacted."
            : `Automatically approved under standing rule "${rule.name}". No order was placed or supplier contacted.`,
          suggestion,
        ));
        continue;
      } catch (error) {
        logStageError("standing-rule restock approval", error);
        addWarning(input.warnings, `I couldn't apply the standing rule for ${item.ingredient}; manual approval is available.`);
      }
    }
    stockItems.push(stockItem);
  }
  return stockItems;
}

export function cafeLocalDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function readPublicHoliday(date: string): Promise<{ name: string | null; error: boolean }> {
  try {
    const { data, error } = await inventoryClient()
      .from("public_holidays")
      .select("name")
      .eq("jurisdiction", "NSW")
      .eq("holiday_date", date)
      .maybeSingle();
    if (error) throw error;
    return { name: data?.name ?? null, error: false };
  } catch (error) {
    logStageError("public holiday lookup", error);
    return { name: null, error: true };
  }
}

async function loadCachedBrief(date: string, fingerprint: string): Promise<{ brief: DailyBrief | null; warning?: string }> {
  try {
    const { data, error } = await inventoryClient()
      .from("daily_briefs")
      .select(BRIEF_SELECT)
      .eq("brief_date", date)
      .maybeSingle();
    if (error) throw error;
    if (!data) return { brief: null };
    const storedDetails = data.details;
    const detailsObject = storedDetails && typeof storedDetails === "object" && !Array.isArray(storedDetails)
      ? storedDetails as Record<string, unknown>
      : null;
    if (detailsObject?.schemaVersion !== CACHE_SCHEMA_VERSION || detailsObject?.sourceFingerprint !== fingerprint) return { brief: null };
    const parsed = dailyBriefSchema.safeParse({
      greeting: data.greeting,
      status_line: data.status_line,
      traffic: detailsObject.traffic,
      stock_items: detailsObject.stock_items,
      all_clear: data.all_clear,
      data_warnings: detailsObject.data_warnings,
    });
    if (!parsed.success) {
      console.error("The cached daily brief failed validation; it will be regenerated:", parsed.error.issues.map((issue) => ({
        path: issue.path,
        code: issue.code,
      })));
      return { brief: null };
    }
    try {
      const approvedRows = await readApprovedRestocks(inventoryClient(), date);
      return { brief: markApprovedRestocks(parsed.data, approvedRestockDetails(approvedRows)) };
    } catch (error) {
      logStageError("saved restock approval lookup", error);
      const warnings = [...parsed.data.data_warnings];
      addWarning(warnings, "I couldn't confirm whether a restock was already approved.");
      return { brief: { ...parsed.data, data_warnings: warnings } };
    }
  } catch (error) {
    logStageError("cache read", error);
    return { brief: null, warning: "I couldn't load the saved brief; I prepared a fresh one." };
  }
}

async function generateDailyBrief(date: string): Promise<DailyBrief> {
  const warnings: string[] = [];
  let db: ReturnType<typeof inventoryClient> | null = null;
  try {
    db = inventoryClient();
  } catch (error) {
    logStageError("Supabase connection", error);
    addWarning(warnings, "I couldn't connect to café data today.");
  }

  const read = <T>(name: string, task: () => Promise<T>) => db
    ? readSection(name, warnings, task)
    : Promise.resolve(null);
  const salesStart = shiftDate(date, -56);
  const [
    salesRows,
    holidayRows,
    ingredientRows,
    inventoryRows,
    recipeRows,
    deliveryRows,
    receiptRows,
    supplierRows,
    standingRuleRows,
    approvedRows,
  ] = await Promise.all([
    read("recent sales", () => readRows(
      db!, "sales_history", "sales_date,product_name,units_sold,is_public_holiday,source",
      ["sales_date", "product_name"], { column: "sales_date", from: salesStart, to: date },
    )),
    read("the NSW public holiday calendar", async () => {
      const { data, error } = await db!.from("public_holidays")
        .select("name")
        .eq("jurisdiction", "NSW")
        .eq("holiday_date", date)
        .maybeSingle();
      if (error) throw error;
      return data?.name ?? null;
    }),
    read("ingredient details", () => readRows(db!, "ingredients", "ingredient_id,ingredient_name,unit", ["ingredient_id"])),
    read("inventory", () => readRows(db!, "inventory", "ingredient_id,quantity_in_stock,minimum_stock,last_updated", ["ingredient_id"])),
    read("recipes", () => readRows(db!, "recipes", "product_name,ingredient_id,quantity_required", ["product_name", "ingredient_id"])),
    read("incoming deliveries", () => readRows(db!, "incoming_deliveries", "delivery_id,ingredient_id,quantity,expected_date", ["delivery_id"])),
    read("delivery receipts", () => readRows(db!, "delivery_receipts", "delivery_id,received_quantity,received_at", ["delivery_id"])),
    read("supplier prices", () => readRows(db!, "supplier_prices", "supplier,ingredient_id,price,delivery_time,minimum_order", ["ingredient_id", "price"])),
    read("standing rules", () => readRows(db!, "standing_rules", "id,name,enabled,ingredient_ids,supplier,maximum_total", ["id"])),
    read("approved restocks for this date", () => readApprovedRestocks(db!, date)),
  ]);

  let traffic: TrafficForecast | null = null;
  if (salesRows) {
    try {
      if (holidayRows === null && warnings.includes("I couldn't check the NSW public holiday calendar today.")) {
        addWarning(warnings, "I couldn't include a public-holiday adjustment in the traffic forecast.");
      } else {
        traffic = calculateTrafficForecast(parseSalesRows(salesRows), date, holidayRows !== null);
      }
    } catch (error) {
      logStageError("traffic calculation", error);
      addWarning(warnings, "I couldn't calculate today's traffic forecast from the sales data.");
    }
  }
  if (!salesRows) addWarning(warnings, "I couldn't calculate today's traffic forecast from the sales data.");

  let ingredients: Array<{ id: string; name: string; unit: string }> = [];
  let inventory: Array<{
    id: string;
    quantity: number | null;
    minimum: number | null;
    updatedAt: string | null;
  }> = [];
  let recipes: Array<{ product: string; ingredientId: string; quantityRequired: number }> = [];
  try {
    if (ingredientRows) ingredients = ingredientRows.map((row) => {
      const unit = parseText(row.unit, "Ingredient unit");
      if (unit !== "ml" && unit !== "g" && unit !== "pcs") {
        throw new Error(`Ingredient unit ${unit} is not supported.`);
      }
      return {
        id: String(row.ingredient_id),
        name: parseText(row.ingredient_name, "Ingredient name"),
        unit,
      };
    });
    if (inventoryRows) inventory = inventoryRows.map((row) => ({
      id: String(row.ingredient_id),
      quantity: row.quantity_in_stock === null ? null : parseNumber(row.quantity_in_stock, "Inventory quantity"),
      minimum: row.minimum_stock === null ? null : parseNumber(row.minimum_stock, "Minimum stock"),
      updatedAt: typeof row.last_updated === "string" ? row.last_updated : null,
    }));
    if (recipeRows) recipes = recipeRows.map((row) => ({
      product: parseText(row.product_name, "Recipe product"),
      ingredientId: String(row.ingredient_id),
      quantityRequired: parseNumber(row.quantity_required, "Recipe quantity"),
    }));
  } catch (error) {
    logStageError("stock data validation", error);
    addWarning(warnings, "I couldn't calculate projected ingredient usage from the stock and recipe data.");
    ingredients = [];
    inventory = [];
    recipes = [];
  }

  if (ingredientRows && inventoryRows && inventoryRows.length < ingredientRows.length) {
    const missing = ingredientRows.length - inventoryRows.length;
    addWarning(warnings, `${missing} ingredient${missing === 1 ? " has" : "s have"} no inventory record and couldn't be checked.`);
  }
  const incompleteInventory = inventory.filter((item) => item.quantity === null || item.minimum === null).length;
  if (incompleteInventory > 0) {
    addWarning(warnings, `${incompleteInventory} inventory record${incompleteInventory === 1 ? " has" : "s have"} a missing stock quantity or minimum and couldn't be assessed.`);
  }
  const now = Date.now();
  const staleIds = new Set(inventory.flatMap((item) => {
    const updatedAt = item.updatedAt ? Date.parse(item.updatedAt) : NaN;
    return !Number.isFinite(updatedAt)
      || updatedAt > now + 5 * 60 * 1000
      || now - updatedAt > 7 * 24 * 60 * 60 * 1000
      ? [item.id]
      : [];
  }));
  if (staleIds.size > 0) {
    addWarning(warnings, `${staleIds.size} inventory record${staleIds.size === 1 ? " has" : "s have"} stale or missing update times and couldn't be used.`);
  }
  inventory = inventory.filter((item) => !staleIds.has(item.id));

  const incomingByIngredient = new Map<string, number>();
  const incomingWithinThreeDays = new Map<string, number>();
  const deliveryIssues = new Set<string>();
  const receivedByDelivery = new Map<string, number>();
  let incomingIsReliable = Boolean(deliveryRows && receiptRows);
  try {
    if (deliveryRows && receiptRows) {
      for (const row of receiptRows) {
        sydneyDate(parseText(row.received_at, "Delivery receipt date"));
        // Current stock includes all posted receipts, including for simulated dates.
        const deliveryId = String(row.delivery_id);
        receivedByDelivery.set(
          deliveryId,
          (receivedByDelivery.get(deliveryId) ?? 0) + parseNumber(row.received_quantity, "Received quantity"),
        );
      }
      for (const row of deliveryRows) {
        const deliveryId = String(row.delivery_id);
        const ingredientId = String(row.ingredient_id);
        const quantity = parseNumber(row.quantity, "Delivery quantity");
        const expectedDate = parseDate(row.expected_date, "Delivery expected date");
        const remaining = Math.max(0, quantity - (receivedByDelivery.get(deliveryId) ?? 0));
        if (expectedDate >= date && expectedDate < shiftDate(date, 3)) {
          incomingWithinThreeDays.set(
            ingredientId,
            (incomingWithinThreeDays.get(ingredientId) ?? 0) + remaining,
          );
          if (expectedDate === date) {
            incomingByIngredient.set(ingredientId, (incomingByIngredient.get(ingredientId) ?? 0) + remaining);
          }
          if (remaining > 0 && (receivedByDelivery.get(deliveryId) ?? 0) > 0) {
            deliveryIssues.add(ingredientId);
            addWarning(warnings, `A delivery for ${ingredients.find((item) => item.id === ingredientId)?.name ?? "an ingredient"} is short.`);
          }
        } else if (expectedDate < date && remaining > 0) {
          deliveryIssues.add(ingredientId);
          addWarning(warnings, `A delivery for ${ingredients.find((item) => item.id === ingredientId)?.name ?? "an ingredient"} is overdue and was not counted as incoming stock.`);
        }
      }
    } else {
      addWarning(warnings, "I couldn't check deliveries before estimating projected stock.");
    }
  } catch (error) {
    logStageError("delivery calculation", error);
    addWarning(warnings, "I couldn't check deliveries before estimating projected stock.");
    incomingByIngredient.clear();
    incomingWithinThreeDays.clear();
    incomingIsReliable = false;
  }

  let usageAvailable = Boolean(traffic && recipeRows && recipeRows.length > 0);
  if (usageAvailable && traffic) {
    const recipeProducts = new Set(recipes.map((recipe) => recipe.product));
    usageAvailable = [...traffic.productShares.keys()].every((product) => recipeProducts.has(product));
    if (!usageAvailable) {
      addWarning(warnings, "I couldn't project usage for every recently sold product because a recipe is missing.");
    }
  }

  let stock: StockAttention[] = [];
  try {
    stock = calculateStockAttention({
      ingredients,
      inventory,
      recipes,
      traffic,
      usageAvailable,
      incomingByIngredient,
      deliveryIssues,
    });
  } catch (error) {
    logStageError("stock calculation", error);
    addWarning(warnings, "I couldn't calculate which ingredients need attention.");
  }

  const offersByIngredient = new Map<string, SupplierOffer[]>();
  try {
    for (const row of supplierRows ?? []) {
      const ingredientId = String(row.ingredient_id);
      const supplier = parseText(row.supplier, "Supplier name");
      const price = parseNumber(row.price, "Supplier price");
      const deliveryTime = parseText(row.delivery_time, "Supplier delivery time");
      const minimumOrder = parseNumber(row.minimum_order, "Supplier minimum order");
      const offers = offersByIngredient.get(ingredientId) ?? [];
      offers.push({ supplier, price, deliveryTime, minimumOrder });
      offersByIngredient.set(ingredientId, offers);
    }
  } catch (error) {
    logStageError("supplier price validation", error);
    offersByIngredient.clear();
    addWarning(warnings, "I couldn't verify supplier prices for suggested restocks.");
  }
  if (!supplierRows) addWarning(warnings, "I couldn't verify supplier prices for suggested restocks.");

  const stockItems = await stockBriefItems({
    date,
    stock,
    incomingWithinThreeDays,
    incomingIsReliable,
    supplierOffers: offersByIngredient,
    standingRules: standingRuleRows,
    approvedRestocks: approvedRestockDetails(approvedRows),
    warnings,
  });
  const greetingResult = await generateGreeting({ date, traffic, stock, warnings });
  if (greetingResult.warning) addWarning(warnings, greetingResult.warning);
  return toBrief({
    date,
    greeting: greetingResult.greeting,
    traffic,
    holidayName: typeof holidayRows === "string" ? holidayRows : null,
    stock,
    stockItems,
    warnings,
  });
}

export async function getDailyBrief(options: { refresh?: boolean; date?: string } = {}): Promise<DailyBrief & { briefDate: string }> {
  const date = options.date ?? cafeLocalDate();
  if (!isValidISODate(date)) throw new Error("The requested brief date is invalid.");

  return withConsistentBrief({
    refresh: options.refresh,
    fingerprint: async () => {
      const { data, error } = await inventoryClient().rpc("inventory_brief_fingerprint");
      if (error || typeof data !== "string") throw new Error("Brief freshness could not be verified. Check inventory-agent-integration.sql.");
      return data;
    },
    load: async (fingerprint) => (await loadCachedBrief(date, fingerprint)).brief,
    generate: () => generateDailyBrief(date),
    save: (brief, fingerprint) => saveBrief(date, brief, fingerprint),
  }).then(brief => ({ ...brief, briefDate: date }));
}

async function saveBrief(date: string, brief: DailyBrief, fingerprint: string): Promise<DailyBrief & { briefDate: string }> {
  try {
    const { error } = await inventoryClient()
      .from("daily_briefs")
      .upsert({
        brief_date: date,
        greeting: brief.greeting,
        status_line: brief.status_line,
        items: [],
        all_clear: brief.all_clear,
        details: {
          schemaVersion: CACHE_SCHEMA_VERSION,
          sourceFingerprint: fingerprint,
          traffic: brief.traffic,
          stock_items: brief.stock_items,
          data_warnings: brief.data_warnings,
        },
        generated_at: new Date().toISOString(),
      }, { onConflict: "brief_date" });
    if (error) throw error;
  } catch (error) {
    logStageError("cache save", error);
    addWarning(brief.data_warnings, "This brief couldn't be saved and may need to be generated again.");
  }
  return { ...brief, briefDate: date };
}
