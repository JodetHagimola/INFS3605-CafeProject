import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { createClient } from "@supabase/supabase-js";
import { generateText, isStepCount, tool } from "ai";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

const AGENT_SYSTEM_PROMPT = `CONTEXT
Margaret owns a small café in Surry Hills and manages finances, ordering and team training herself. Each week she manually checks stock levels, estimates how much to order based on past demand and the holiday season, then phones several suppliers to compare prices and delivery times before calling her chosen supplier with the order. Stock counts, supplier prices and demand patterns live in her head, on paper or across phone calls.

PROBLEM
Café owners like Margaret have trouble keeping track of inventory and lack accurate, real-time information about stock and future demand. This makes ordering slow and inconsistent, increasing the risk of overordering (waste, storage cost) and underordering (stockouts at busy periods), which reduces profit margins. Margaret needs help working out what to order, how much, and from whom, without spending hours counting stock and calling suppliers.

ROLE AND USER
You support this user: Margaret, the café owner, when she plans her weekly (or pre-holiday) ingredient order.

TASK
Each time Margaret requests a replenishment check, the agent: (1) runs the demand forecast for the chosen date or period, (2) converts predicted drink sales into ingredient requirements using the recipes table, (3) reads current inventory and subtracts it from requirements to find shortfalls, (4) checks for incoming deliveries and any inventory discrepancies, (5) looks up supplier prices and delivery times for each short ingredient, and (6) saves a draft order with a recommended supplier and quantity per ingredient, plus a short explanation of its reasoning.

GOAL
A draft order Margaret can review, adjust and approve in under five minutes, instead of the hours she currently spends counting stock and phoning suppliers.

INFORMATION AND KNOWLEDGE
The agent may only use: the saved forecasting model output (predicted sales per drink for the requested date); the Supabase tables recipes and ingredients (product, ingredient, quantity per drink, unit); the inventory table (ingredient, quantity in stock); the incoming_deliveries table (ingredient, quantity, expected date); and the supplier_prices table (supplier, ingredient, price, delivery time, minimum order). It may also read the café’s public holiday data used by the forecast.

If any required data is missing, conflicting or out of date (for example, no supplier price for an ingredient, or an inventory record that hasn’t been updated recently), the agent must say so in its output and flag that item for Margaret instead of guessing. It must state that the forecast is based on a model trained on synthetic data, so predictions are indicative only, until retrained on real sales.
Ask focused questions when essential information is missing. Do not invent facts. Distinguish confirmed information, reported information and uncertainty.

PROCESS
1. Understand the request and the intended outcome.
2. Gather or retrieve only the permitted information.
3. Identify important gaps, conflicts or uncertainty.
4. Complete the task within the stated boundaries.
5. Prepare the required output for the user.

REQUIRED OUTPUT
A draft order saved to a draft_orders table with status “draft”, containing: one line per ingredient needing replenishment (ingredient, required quantity, current stock, incoming stock, recommended order quantity, unit); a recommended supplier with price and delivery time for each line, plus the next-best alternative; a short plain-English reason for each recommendation; a list of flags (missing prices, possible inventory discrepancy, low-confidence forecast); and the forecast and data it used. Margaret reads this on the Automated Ordering page of the website.

BOUNDARIES
The agent must never place or send an order to a supplier, mark an order as approved or sent, or contact any supplier. It must never change or delete inventory records, recipes, supplier prices or existing orders. It must never recommend a supplier or price that isn’t in the supplier prices table, and must never invent figures. It must never recommend a negative order quantity. It stops and flags to Margaret if: the forecast fails to run, inventory data is missing, no supplier price exists for a short ingredient, or the recommended order is unusually large compared with normal usage (for example more than double the forecast requirement).
Do not exceed the authority granted in these instructions. Do not present a recommendation as a final decision when human approval is required.

HUMAN REVIEW AND ESCALATION
Margaret reviews every draft order, decides the final quantities and supplier, and approves and sends the order herself. The agent must escalate to Margaret (flagged at the top of the draft) when: stock on hand doesn’t match expected usage or deliveries (a possible discrepancy); a delivery is expected but overdue; the forecast date is a public holiday or unusual period; a perishable ingredient might expire before it’s used; there’s only one supplier or none for an ingredient; or the cost of the order is significantly higher than her usual spend.
Stop and escalate when essential information cannot be obtained, available information is conflicting, the task falls outside the approved scope, or the required action exceeds the agent’s authority.`;

const emptyInput = z.object({}).strict();
const supplierChoiceSchema = z.object({
  supplier: z.string().min(1).max(120),
  price: z.number().finite().nonnegative(),
  deliveryTime: z.string().min(1).max(120),
  minimumOrder: z.number().finite().nonnegative(),
}).strict();

const saveDraftInput = z.object({
  lines: z.array(z.object({
    ingredientId: z.string().min(1).max(100),
    requiredQuantity: z.number().finite().nonnegative(),
    currentStock: z.number().finite().nonnegative(),
    incomingStock: z.number().finite().nonnegative(),
    recommendedOrderQuantity: z.number().finite().nonnegative(),
    unit: z.string().min(1).max(40),
    recommendedSupplier: supplierChoiceSchema,
    reason: z.string().trim().min(1).max(500),
  }).strict()).max(100),
}).strict();

type RawRow = Record<string, unknown>;
type Forecast = {
  forecastDate: string;
  isPublicHoliday: boolean;
  predictedSales: Record<string, number>;
  source: string;
};
type Ingredient = {
  ingredientId: string;
  ingredientName: string;
  unit: string;
};
type Recipe = {
  productName: string;
  ingredientId: string;
  quantityPerDrink: number;
};
type InventoryRecord = {
  ingredientId: string;
  quantity: number;
  lastUpdated: string | null;
};
type Delivery = {
  ingredientId: string;
  quantity: number;
  expectedDate: string;
};
type SupplierPrice = {
  supplier: string;
  ingredientId: string;
  price: number;
  deliveryTime: string;
  minimumOrder: number;
};
type SupplierChoice = {
  supplier: string;
  price: number;
  deliveryTime: string;
  minimumOrder: number;
};
type DraftLine = {
  ingredientId: string;
  ingredient: string;
  requiredQuantity: number;
  currentStock: number;
  incomingStock: number;
  recommendedOrderQuantity: number;
  unit: string;
  recommendedSupplier: SupplierChoice;
  alternativeSupplier: SupplierChoice | null;
  reason: string;
};
export type DraftOrder = {
  id: string;
  status: "draft" | "approved";
  forecastDate: string;
  createdAt: string;
  forecast: Forecast;
  lines: DraftLine[];
  flags: string[];
  dataUsed: {
    recipes: Recipe[];
    inventory: InventoryRecord[];
    deliveries: Delivery[];
    supplierPrices: SupplierPrice[];
  };
};

function isPasscodeMatch(supplied: string): boolean {
  const expected = process.env.AGENT_PASSCODE;
  if (!expected) throw new Error("AGENT_PASSCODE is missing from .env.local.");
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length
    && timingSafeEqual(expectedBytes, suppliedBytes);
}

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL and SUPABASE_SECRET_KEY are required in .env.local.");
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function record(value: unknown, label: string): RawRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} contains an invalid row.`);
  }
  return value as RawRow;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value.trim();
}

function idText(value: unknown, label: string): string {
  if ((typeof value !== "string" && typeof value !== "number") || !String(value).trim()) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return String(value);
}

function numberValue(value: unknown, label: string): number {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`${label} is missing or invalid.`);
  }
  if (typeof value === "string" && !value.trim()) {
    throw new Error(`${label} is missing or invalid.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return parsed;
}

async function readAll(table: string, columns: string): Promise<RawRow[]> {
  const supabase = createSupabaseClient();
  const rows: RawRow[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase
      .from(table)
      .select(columns)
      .range(offset, offset + 499);
    if (error) {
      console.error(`Could not read ${table}:`, error.message);
      throw new Error(`Could not read the required ${table} data.`);
    }
    const page = (data ?? []).map((item) => record(item, table));
    rows.push(...page);
    if (page.length < 500) return rows;
  }
}

function toForecast(value: unknown, requestedDate: string, isPublicHoliday: boolean): Forecast {
  const result = record(value, "Forecast service");
  if (result.status !== "success"
    || result.forecastDate !== requestedDate
    || result.isPublicHoliday !== isPublicHoliday
    || !result.predictedSales
    || typeof result.predictedSales !== "object"
    || Array.isArray(result.predictedSales)) {
    throw new Error("The forecast service returned incomplete or conflicting data.");
  }
  const rawSales = result.predictedSales as Record<string, unknown>;
  const predictedSales: Record<string, number> = {};
  for (const product of ["Latte", "Cappuccino", "Flat White", "Long Black", "Mocha"]) {
    const sales = numberValue(rawSales[product], `Forecast for ${product}`);
    if (!Number.isSafeInteger(sales)) {
      throw new Error(`Forecast for ${product} is not a whole number.`);
    }
    predictedSales[product] = sales;
  }
  return {
    forecastDate: requestedDate,
    isPublicHoliday,
    predictedSales,
    source: text(result.source, "Forecast source"),
  };
}

function parseIngredients(rows: RawRow[]): Ingredient[] {
  if (rows.length === 0) throw new Error("The ingredients table is empty.");
  const seen = new Set<string>();
  return rows.map((row) => {
    const ingredientId = idText(row.ingredient_id, "Ingredient ID");
    const ingredientName = text(row.ingredient_name, "Ingredient name");
    const unit = text(row.unit, `Unit for ${ingredientName}`);
    if (seen.has(ingredientId)) throw new Error("The ingredients table contains duplicate IDs.");
    seen.add(ingredientId);
    return { ingredientId, ingredientName, unit };
  });
}

function parseRecipes(rows: RawRow[], ingredients: Ingredient[]): Recipe[] {
  if (rows.length === 0) throw new Error("The recipes table is empty.");
  const ingredientIds = new Set(ingredients.map((item) => item.ingredientId));
  const seen = new Set<string>();
  return rows.map((row) => {
    const productName = text(row.product_name, "Recipe product name");
    const ingredientId = idText(row.ingredient_id, "Recipe ingredient ID");
    if (!ingredientIds.has(ingredientId)) {
      throw new Error(`Recipe data refers to an unknown ingredient ID: ${ingredientId}.`);
    }
    const recipeKey = `${productName}\u0000${ingredientId}`;
    if (seen.has(recipeKey)) throw new Error(`Recipe data conflicts for ${productName}.`);
    seen.add(recipeKey);
    const quantityPerDrink = numberValue(row.quantity_required, `Recipe quantity for ${productName}`);
    if (quantityPerDrink === 0) throw new Error(`Recipe quantity for ${productName} must be positive.`);
    return { productName, ingredientId, quantityPerDrink };
  });
}

function parseInventory(rows: RawRow[]): InventoryRecord[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const ingredientId = idText(row.ingredient_id, "Inventory ingredient ID");
    if (seen.has(ingredientId)) {
      throw new Error(`Inventory data contains duplicate records for ${ingredientId}.`);
    }
    seen.add(ingredientId);
    const lastUpdated = row.last_updated == null
      ? null
      : text(row.last_updated, `Inventory update time for ${ingredientId}`);
    if (lastUpdated && !Number.isFinite(Date.parse(lastUpdated))) {
      throw new Error(`Inventory update time for ${ingredientId} is invalid.`);
    }
    return {
      ingredientId,
      quantity: numberValue(row.quantity_in_stock, `Stock quantity for ${ingredientId}`),
      lastUpdated,
    };
  });
}

function parseDeliveries(rows: RawRow[]): Delivery[] {
  return rows.map((row) => {
    const ingredientId = idText(row.ingredient_id, "Delivery ingredient ID");
    const expectedDate = text(row.expected_date, `Delivery date for ${ingredientId}`);
    if (!Number.isFinite(Date.parse(expectedDate))) {
      throw new Error(`Delivery date for ${ingredientId} is invalid.`);
    }
    return {
      ingredientId,
      quantity: numberValue(row.quantity, `Delivery quantity for ${ingredientId}`),
      expectedDate,
    };
  });
}

function parseSupplierPrices(rows: RawRow[]): SupplierPrice[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const ingredientId = idText(row.ingredient_id, "Supplier-price ingredient ID");
    const deliveryTime = typeof row.delivery_time === "number"
      ? String(row.delivery_time)
      : text(row.delivery_time, `Delivery time for ${ingredientId}`);
    const supplier = text(row.supplier, `Supplier for ${ingredientId}`);
    const priceKey = `${supplier}\u0000${ingredientId}`;
    if (seen.has(priceKey)) {
      throw new Error(`Supplier-price data conflicts for ${supplier} and ingredient ${ingredientId}.`);
    }
    seen.add(priceKey);
    return {
      supplier,
      ingredientId,
      price: numberValue(row.price, `Supplier price for ${ingredientId}`),
      deliveryTime,
      minimumOrder: numberValue(row.minimum_order, `Minimum order for ${ingredientId}`),
    };
  });
}

function sameNumber(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.000001 * Math.max(1, Math.abs(left), Math.abs(right));
}

function sameSnapshot<T>(left: T[], right: T[]): boolean {
  const serialize = (rows: T[]) => rows.map((row) => JSON.stringify(row)).sort();
  return JSON.stringify(serialize(left)) === JSON.stringify(serialize(right));
}

function publicChoice(price: SupplierPrice): SupplierChoice {
  return {
    supplier: price.supplier,
    price: price.price,
    deliveryTime: price.deliveryTime,
    minimumOrder: price.minimumOrder,
  };
}

function assertKnownSupplierChoice(choice: SupplierChoice, prices: SupplierPrice[], ingredientId: string) {
  const match = prices.find((price) =>
    price.ingredientId === ingredientId
    && price.supplier === choice.supplier
    && sameNumber(price.price, choice.price)
    && price.deliveryTime === choice.deliveryTime
    && sameNumber(price.minimumOrder, choice.minimumOrder));
  if (!match) {
    throw new Error(`The recommended supplier or price for ingredient ${ingredientId} was not in supplier_prices.`);
  }
  return match;
}

function makeToolCounter() {
  let count = 0;
  return () => {
    count += 1;
    if (count > 5) throw new Error("The agent reached its five-tool-call limit.");
  };
}

export async function runAgent(input: {
  passcode: string;
  request: string;
  forecastDate: string;
  isPublicHoliday: boolean;
}): Promise<{ answer: string; draft: DraftOrder | null; toolCalls: number }> {
  if (!isPasscodeMatch(input.passcode)) {
    throw new Error("The passcode does not match.");
  }
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error("GOOGLE_GENERATIVE_AI_API_KEY is missing from .env.local.");
  }

  const forecastDate = new Date(`${input.forecastDate}T00:00:00.000Z`);
  if (!Number.isFinite(forecastDate.getTime())
    || forecastDate.toISOString().slice(0, 10) !== input.forecastDate) {
    throw new Error("Choose a valid forecast date.");
  }

  const countToolCall = makeToolCounter();
  const context: {
    forecast?: Forecast;
    ingredients?: Ingredient[];
    recipes?: Recipe[];
    inventory?: InventoryRecord[];
    deliveries?: Delivery[];
    supplierPrices?: SupplierPrice[];
    draft?: DraftOrder;
  } = {};

  const google = createGoogle({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY });
  const result = await generateText({
    model: google("gemini-3.8-flash"),
    instructions: AGENT_SYSTEM_PROMPT,
    prompt: [
      `Margaret's request: ${input.request}`,
      `Forecast date requested by Margaret: ${input.forecastDate}.`,
      `The person marked this date as a public holiday: ${input.isPublicHoliday ? "yes" : "no"}.`,
      "Use only the supplied tools. Stop when essential information is unavailable or conflicting.",
    ].join("\n\n"),
    tools: {
      forecastDemand: tool({
        description: "Run the saved synthetic-data sales model for the date selected by Margaret.",
        inputSchema: emptyInput,
        execute: async () => {
          countToolCall();
          const response = await fetch("http://127.0.0.1:8000/forecast", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              forecast_date: input.forecastDate,
              is_public_holiday: input.isPublicHoliday,
            }),
            cache: "no-store",
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error("The saved forecast model could not run.");
          const forecast = toForecast(await response.json(), input.forecastDate, input.isPublicHoliday);
          context.forecast = forecast;
          return forecast;
        },
      }),
      readRecipes: tool({
        description: "Read only the recipes and ingredient names, units, and quantities per drink.",
        inputSchema: emptyInput,
        execute: async () => {
          countToolCall();
          const [ingredientRows, recipeRows] = await Promise.all([
            readAll("ingredients", "ingredient_id,ingredient_name,unit"),
            readAll("recipes", "product_name,ingredient_id,quantity_required"),
          ]);
          const ingredients = parseIngredients(ingredientRows);
          const recipes = parseRecipes(recipeRows, ingredients);
          context.ingredients = ingredients;
          context.recipes = recipes;
          return { ingredients, recipes };
        },
      }),
      readInventoryAndDeliveries: tool({
        description: "Read inventory quantity and update time, plus incoming delivery quantity and expected date.",
        inputSchema: emptyInput,
        execute: async () => {
          countToolCall();
          const [inventoryRows, deliveryRows] = await Promise.all([
            readAll("inventory", "ingredient_id,quantity_in_stock,last_updated"),
            readAll("incoming_deliveries", "ingredient_id,quantity,expected_date"),
          ]);
          const inventory = parseInventory(inventoryRows);
          const deliveries = parseDeliveries(deliveryRows);
          context.inventory = inventory;
          context.deliveries = deliveries;
          return { inventory, deliveries };
        },
      }),
      readSupplierPrices: tool({
        description: "Read only supplier, ingredient, price, delivery time, and minimum order from supplier_prices.",
        inputSchema: emptyInput,
        execute: async () => {
          countToolCall();
          const rows = await readAll(
            "supplier_prices",
            "supplier,ingredient_id,price,delivery_time,minimum_order",
          );
          const supplierPrices = parseSupplierPrices(rows);
          context.supplierPrices = supplierPrices;
          return supplierPrices;
        },
      }),
      saveDraftOrder: tool({
        description: "Save a draft only after every required source has been read. The server independently checks every quantity and supplier against the source tables. This tool cannot approve or send an order.",
        inputSchema: saveDraftInput,
        execute: async ({ lines }) => {
          countToolCall();
          const forecast = context.forecast;
          const ingredients = context.ingredients;
          const recipes = context.recipes;
          const inventory = context.inventory;
          const deliveries = context.deliveries;
          const supplierPrices = context.supplierPrices;
          if (!forecast || !ingredients || !recipes || !inventory || !deliveries || !supplierPrices) {
            throw new Error("Read the forecast and all permitted data before saving a draft.");
          }

          const [currentIngredientRows, currentRecipeRows, currentInventoryRows, currentDeliveryRows, currentPriceRows] =
            await Promise.all([
              readAll("ingredients", "ingredient_id,ingredient_name,unit"),
              readAll("recipes", "product_name,ingredient_id,quantity_required"),
              readAll("inventory", "ingredient_id,quantity_in_stock,last_updated"),
              readAll("incoming_deliveries", "ingredient_id,quantity,expected_date"),
              readAll("supplier_prices", "supplier,ingredient_id,price,delivery_time,minimum_order"),
            ]);
          const currentIngredients = parseIngredients(currentIngredientRows);
          const currentRecipes = parseRecipes(currentRecipeRows, currentIngredients);
          const currentInventory = parseInventory(currentInventoryRows);
          const currentDeliveries = parseDeliveries(currentDeliveryRows);
          const currentSupplierPrices = parseSupplierPrices(currentPriceRows);
          if (!sameSnapshot(ingredients, currentIngredients)
            || !sameSnapshot(recipes, currentRecipes)
            || !sameSnapshot(inventory, currentInventory)
            || !sameSnapshot(deliveries, currentDeliveries)
            || !sameSnapshot(supplierPrices, currentSupplierPrices)) {
            throw new Error("Café data changed while the agent was working. Run the check again before saving.");
          }

          const ingredientById = new Map(currentIngredients.map((ingredient) => [ingredient.ingredientId, ingredient]));
          const requiredById = new Map<string, number>();
          for (const recipe of currentRecipes) {
            const sales = forecast.predictedSales[recipe.productName];
            if (sales === undefined) continue;
            requiredById.set(
              recipe.ingredientId,
              (requiredById.get(recipe.ingredientId) ?? 0) + sales * recipe.quantityPerDrink,
            );
          }

          const stockById = new Map(currentInventory.map((item) => [item.ingredientId, item]));
          const now = Date.now();
          const today = new Date().toISOString().slice(0, 10);
          const requiredLines = [...requiredById.entries()]
            .filter(([, required]) => required > 0)
            .map(([ingredientId, requiredQuantity]) => {
              const ingredient = ingredientById.get(ingredientId);
              const stock = stockById.get(ingredientId);
              if (!ingredient || !stock) {
                throw new Error(`Inventory data is missing for ingredient ${ingredientId}; no draft was saved.`);
              }
              const stockUpdatedAt = stock.lastUpdated ? Date.parse(stock.lastUpdated) : Number.NaN;
              if (!Number.isFinite(stockUpdatedAt)
                || stockUpdatedAt > now + 5 * 60 * 1000
                || now - stockUpdatedAt > 7 * 24 * 60 * 60 * 1000) {
                throw new Error(`Inventory for ${ingredient.ingredientName} is missing a recent update; no draft was saved.`);
              }
              const itemDeliveries = currentDeliveries.filter((delivery) => delivery.ingredientId === ingredientId);
              const overdue = itemDeliveries.find((delivery) =>
                delivery.quantity > 0 && delivery.expectedDate.slice(0, 10) < today);
              if (overdue) {
                throw new Error(`An incoming delivery for ${ingredient.ingredientName} is overdue; no draft was saved.`);
              }
              const incomingStock = itemDeliveries
                .filter((delivery) => delivery.expectedDate.slice(0, 10) <= forecast.forecastDate)
                .reduce((sum, delivery) => sum + delivery.quantity, 0);
              return {
                ingredient,
                ingredientId,
                requiredQuantity,
                currentStock: stock.quantity,
                incomingStock,
                shortfall: Math.max(0, requiredQuantity - stock.quantity - incomingStock),
              };
            })
            .filter((line) => line.shortfall > 0);

          if (lines.length !== requiredLines.length) {
            throw new Error("Draft lines did not match the ingredients that need replenishment; no draft was saved.");
          }

          const submittedById = new Map(lines.map((line) => [line.ingredientId, line]));
          if (submittedById.size !== lines.length) {
            throw new Error("The draft contains duplicate ingredient lines.");
          }

          const verifiedLines: DraftLine[] = [];
          for (const expected of requiredLines) {
            const submitted = submittedById.get(expected.ingredientId);
            if (!submitted
              || !sameNumber(submitted.requiredQuantity, expected.requiredQuantity)
              || !sameNumber(submitted.currentStock, expected.currentStock)
              || !sameNumber(submitted.incomingStock, expected.incomingStock)
              || submitted.unit !== expected.ingredient.unit
              || submitted.recommendedOrderQuantity < expected.shortfall
              || submitted.recommendedOrderQuantity < submitted.recommendedSupplier.minimumOrder
              || submitted.recommendedOrderQuantity > expected.requiredQuantity * 2) {
              throw new Error(`Draft quantities for ${expected.ingredient.ingredientName} failed server checks; no draft was saved.`);
            }

            const availablePrices = currentSupplierPrices.filter((price) => price.ingredientId === expected.ingredientId);
            if (availablePrices.length === 0) {
              throw new Error(`No supplier price exists for ${expected.ingredient.ingredientName}; no draft was saved.`);
            }
            const chosenPrice = assertKnownSupplierChoice(
              submitted.recommendedSupplier,
              currentSupplierPrices,
              expected.ingredientId,
            );
            const alternatives = availablePrices
              .filter((price) => price.supplier !== chosenPrice.supplier)
              .sort((left, right) => left.price - right.price || left.deliveryTime.localeCompare(right.deliveryTime));
            const nextBest = alternatives[0] ? publicChoice(alternatives[0]) : null;

            verifiedLines.push({
              ingredientId: expected.ingredientId,
              ingredient: expected.ingredient.ingredientName,
              requiredQuantity: expected.requiredQuantity,
              currentStock: expected.currentStock,
              incomingStock: expected.incomingStock,
              recommendedOrderQuantity: submitted.recommendedOrderQuantity,
              unit: expected.ingredient.unit,
              recommendedSupplier: publicChoice(chosenPrice),
              alternativeSupplier: nextBest,
              reason: submitted.reason,
            });
          }

          const flags = [
            "Low-confidence forecast: the saved model was trained on synthetic data, so its predictions are indicative only.",
            ...(forecast.isPublicHoliday ? ["The requested forecast date is marked as a public holiday."] : []),
            ...(verifiedLines.some((line) => !line.alternativeSupplier)
              ? ["At least one ingredient has only one listed supplier."] : []),
            "Historical stock movements are not available in the permitted data, so a stock discrepancy cannot be confirmed.",
            "Expiry dates and usual order spending are not available in the permitted data.",
          ];

          const sourceData = {
            recipes: currentRecipes.filter((recipe) =>
              forecast.predictedSales[recipe.productName] !== undefined
              && requiredById.has(recipe.ingredientId)),
            inventory: currentInventory.filter((item) => requiredById.has(item.ingredientId)),
            deliveries: currentDeliveries.filter((item) => requiredById.has(item.ingredientId)),
            supplierPrices: currentSupplierPrices.filter((item) =>
              verifiedLines.some((line) => line.ingredientId === item.ingredientId)),
          };
          const supabase = createSupabaseClient();
          const { data, error } = await supabase
            .from("draft_orders")
            .insert({
              status: "draft",
              forecast_date: forecast.forecastDate,
              forecast,
              lines: verifiedLines,
              flags,
              data_used: sourceData,
            })
            .select("id,status,forecast_date,created_at,forecast,lines,flags,data_used")
            .single();
          if (error || !data) {
            console.error("Could not save an automated ordering draft:", error?.message ?? "No row returned");
            throw new Error("The draft could not be saved. Check the draft_orders setup in Supabase.");
          }

          const draft: DraftOrder = {
            id: String(data.id),
            status: data.status === "approved" ? "approved" : "draft",
            forecastDate: String(data.forecast_date),
            createdAt: String(data.created_at),
            forecast: data.forecast as Forecast,
            lines: data.lines as DraftLine[],
            flags: data.flags as string[],
            dataUsed: data.data_used as DraftOrder["dataUsed"],
          };
          context.draft = draft;
          return draft;
        },
      }),
    },
    stopWhen: isStepCount(5),
  });

  if (!context.draft) {
    throw new Error("The agent did not save a draft. Try again or check the agent response.");
  }

  return {
    answer: result.text,
    draft: context.draft,
    toolCalls: result.toolCalls.length,
  };
}

export function checkAgentPasscode(passcode: string): boolean {
  return isPasscodeMatch(passcode);
}

export async function getLatestDraft(): Promise<
  { draft: DraftOrder | null; error: string | null }
> {
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from("draft_orders")
      .select("id,status,forecast_date,created_at,forecast,lines,flags,data_used")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      console.error("Could not load the latest automated ordering draft:", error.message);
      return { draft: null, error: "The draft could not be loaded. Check the draft_orders setup in Supabase." };
    }
    if (!data) return { draft: null, error: null };
    return {
      draft: {
        id: String(data.id),
        status: data.status === "approved" ? "approved" : "draft",
        forecastDate: String(data.forecast_date),
        createdAt: String(data.created_at),
        forecast: data.forecast as Forecast,
        lines: data.lines as DraftLine[],
        flags: data.flags as string[],
        dataUsed: data.data_used as DraftOrder["dataUsed"],
      },
      error: null,
    };
  } catch {
    return { draft: null, error: "Add SUPABASE_URL and SUPABASE_SECRET_KEY to .env.local." };
  }
}

export async function approveDraft(passcode: string, draftId: string): Promise<
  { status: "approved"; error: null } | { status: null; error: string }
> {
  if (!checkAgentPasscode(passcode)) {
    return { status: null, error: "The passcode does not match." };
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draftId)) {
    return { status: null, error: "Choose a valid draft to approve." };
  }
  try {
    const supabase = createSupabaseClient();
    const { data, error } = await supabase
      .from("draft_orders")
      .update({ status: "approved", approved_at: new Date().toISOString() })
      .eq("id", draftId)
      .eq("status", "draft")
      .select("status")
      .maybeSingle();
    if (error) {
      console.error("Could not approve the automated ordering draft:", error.message);
      return { status: null, error: "The draft could not be approved. Check the draft_orders setup in Supabase." };
    }
    if (!data) return { status: null, error: "This draft is no longer waiting for approval." };
    return { status: "approved", error: null };
  } catch {
    return { status: null, error: "Supabase settings are missing or unavailable." };
  }
}
