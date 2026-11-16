import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import { isEmail } from "@/lib/automation/mail-model";
import { inventoryClient } from "@/lib/inventory/server";

export const runtime = "nodejs";

const moneySchema = z.number().finite().min(0.01).max(1_000_000);
const policySchema = z.object({
  operation: z.literal("save-policy"),
  autoOrderLimit: moneySchema,
  dailyLimit: moneySchema,
  weeklyLimit: moneySchema.nullable(),
}).strict();
const pauseSchema = z.object({
  operation: z.literal("set-pause"),
  paused: z.boolean(),
}).strict();
const reorderRuleSchema = z.object({
  operation: z.literal("save-reorder-rule"),
  ingredientId: z.string().regex(/^\d{1,18}$/),
  supplier: z.string().trim().min(1).max(120),
  packs: z.number().int().min(1).max(10_000),
  orderLimit: moneySchema,
  enabled: z.boolean(),
}).strict();
const timeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
const rushWindowSchema = z.object({ start: timeSchema, end: timeSchema }).strict();
const profileSchema = z.object({
  operation: z.literal("save-profile"),
  cafeName: z.string().trim().min(1).max(120),
  ownerName: z.string().trim().max(120),
  ownerEmail: z.string().trim().max(254),
  openTime: timeSchema,
  closeTime: timeSchema,
  rushWindows: z.array(rushWindowSchema).max(8),
}).strict();
const supplierSchema = z.object({
  operation: z.literal("save-supplier"),
  name: z.string().trim().min(1).max(120),
  contactEmail: z.string().trim().max(254),
  leadTimeDays: z.number().int().min(0).max(365),
  orderCutoff: z.union([timeSchema, z.literal("")]),
  deliveryWindowStart: z.union([timeSchema, z.literal("")]),
  deliveryWindowEnd: z.union([timeSchema, z.literal("")]),
  active: z.boolean(),
}).strict();

function isDemoSupplier(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const name = value.trim().toLocaleLowerCase();
  return name === "demo seed supplier" || name === "demo wholesale dairy";
}

function time(value: unknown): string {
  return typeof value === "string" ? value.slice(0, 5) : "";
}

function amount(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? String(value) : null;
}

function validRushWindows(windows: Array<{ start: string; end: string }>): boolean {
  const sorted = [...windows].sort((left, right) => left.start.localeCompare(right.start));
  for (let index = 0; index < sorted.length; index += 1) {
    if (sorted[index].start >= sorted[index].end) return false;
    if (index > 0 && sorted[index - 1].end > sorted[index].start) return false;
  }
  return true;
}

export async function GET() {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to view café settings." }, { status: 401 });
  }

  try {
    const db = inventoryClient();
    const [
      cafeResult,
      policyResult,
      ingredientResult,
      inventoryResult,
      supplierResult,
      priceResult,
      reorderResult,
      legacyResult,
    ] = await Promise.all([
      db.from("cafe_settings")
        .select("cafe_name,owner_name,owner_email,open_time,close_time,rush_windows,email_mode,automation_paused")
        .eq("id", 1)
        .single(),
      db.from("cafe_spend_policy")
        .select("auto_order_limit,daily_limit,weekly_limit")
        .eq("id", 1)
        .single(),
      db.from("ingredients").select("ingredient_id,ingredient_name,unit").order("ingredient_name"),
      db.from("inventory").select("ingredient_id,minimum_stock,auto_threshold"),
      db.from("suppliers")
        .select("name,contact_email,lead_time_days,order_cutoff,delivery_window_start,delivery_window_end,active")
        .order("name"),
      db.from("supplier_prices")
        .select("ingredient_id,supplier,price,minimum_order,pack_size,pack_label,lead_time_days")
        .order("ingredient_id"),
      db.from("cafe_reorder_rules")
        .select("ingredient_id,supplier,packs,order_limit,enabled")
        .order("ingredient_id"),
      db.from("standing_rules")
        .select("id,name,enabled,ingredient_ids,supplier,maximum_total")
        .order("created_at", { ascending: false }),
    ]);

    const failedSources: Array<readonly [string, { message: string } | null]> = [
      ["café profile", cafeResult.error],
      ["spend policy", policyResult.error],
      ["ingredients", ingredientResult.error],
      ["inventory", inventoryResult.error],
      ["suppliers", supplierResult.error],
      ["supplier prices", priceResult.error],
      ["reorder rules", reorderResult.error],
      ["legacy approval rules", legacyResult.error
        && !["42P01", "PGRST205"].includes(legacyResult.error.code)
        ? legacyResult.error
        : null],
    ];
    const failed = failedSources.find(([, error]) => error);
    if (failed) {
      console.error(`Could not load ${failed[0]} for Settings:`, failed[1]?.message);
      return NextResponse.json({ error: "Café settings could not be loaded. Check the Supabase setup." }, { status: 500 });
    }
    if (legacyResult.error) {
      console.warn("Legacy standing_rules table is unavailable; Settings will show no legacy rules.");
    }
    if (!cafeResult.data || !policyResult.data) {
      return NextResponse.json({ error: "The café profile or spend policy row is missing." }, { status: 500 });
    }

    const suppliers = (supplierResult.data ?? [])
      .filter((supplier) => !isDemoSupplier(supplier.name))
      .map((supplier) => ({
        name: String(supplier.name),
        contactEmail: typeof supplier.contact_email === "string" ? supplier.contact_email : "",
        leadTimeDays: Number(supplier.lead_time_days),
        orderCutoff: time(supplier.order_cutoff),
        deliveryWindowStart: time(supplier.delivery_window_start),
        deliveryWindowEnd: time(supplier.delivery_window_end),
        active: supplier.active === true,
      }));
    const supplierNames = new Set(suppliers.map((supplier) => supplier.name));
    const rulesByIngredient = new Map((reorderResult.data ?? [])
      .filter((rule) => supplierNames.has(String(rule.supplier)))
      .map((rule) => [String(rule.ingredient_id), rule]));
    const inventoryByIngredient = new Map((inventoryResult.data ?? [])
      .map((stock) => [String(stock.ingredient_id), stock]));
    const offersByIngredient = new Map<string, Array<{
      supplier: string;
      price: string | null;
      minimumOrder: string | null;
      packSize: string | null;
      packLabel: string | null;
      leadTimeDays: number | null;
    }>>();
    for (const offer of priceResult.data ?? []) {
      if (!supplierNames.has(String(offer.supplier))) continue;
      const ingredientId = String(offer.ingredient_id);
      const offers = offersByIngredient.get(ingredientId) ?? [];
      offers.push({
        supplier: String(offer.supplier),
        price: amount(offer.price),
        minimumOrder: amount(offer.minimum_order),
        packSize: amount(offer.pack_size),
        packLabel: typeof offer.pack_label === "string" ? offer.pack_label : null,
        leadTimeDays: offer.lead_time_days == null ? null : Number(offer.lead_time_days),
      });
      offersByIngredient.set(ingredientId, offers);
    }
    const legacyRules = (legacyResult.data ?? [])
      .filter((rule) => String(rule.name).trim().toLocaleLowerCase() !== "dummy rule"
        && !isDemoSupplier(rule.supplier))
      .map((rule) => ({
        name: String(rule.name),
        supplier: typeof rule.supplier === "string" ? rule.supplier : null,
        maximumTotal: amount(rule.maximum_total),
        enabled: rule.enabled === true,
      }));

    return NextResponse.json({
      profile: {
        cafeName: String(cafeResult.data.cafe_name),
        ownerName: typeof cafeResult.data.owner_name === "string" ? cafeResult.data.owner_name : "",
        ownerEmail: typeof cafeResult.data.owner_email === "string" ? cafeResult.data.owner_email : "",
        openTime: time(cafeResult.data.open_time),
        closeTime: time(cafeResult.data.close_time),
        rushWindows: Array.isArray(cafeResult.data.rush_windows)
          ? cafeResult.data.rush_windows.flatMap((entry) => {
            if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
            const window = entry as Record<string, unknown>;
            return typeof window.start === "string" && typeof window.end === "string"
              ? [{ start: window.start.slice(0, 5), end: window.end.slice(0, 5) }]
              : [];
          })
          : [],
        emailMode: String(cafeResult.data.email_mode),
        automationPaused: cafeResult.data.automation_paused === true,
      },
      policy: {
        autoOrderLimit: amount(policyResult.data.auto_order_limit),
        dailyLimit: amount(policyResult.data.daily_limit),
        weeklyLimit: amount(policyResult.data.weekly_limit),
      },
      suppliers,
      ingredients: (ingredientResult.data ?? []).map((ingredient) => {
        const id = String(ingredient.ingredient_id);
        const stock = inventoryByIngredient.get(id);
        const rule = rulesByIngredient.get(id);
        return {
          id,
          name: String(ingredient.ingredient_name),
          unit: String(ingredient.unit),
          minimumStock: amount(stock?.minimum_stock),
          autoThreshold: stock?.auto_threshold === true,
          offers: offersByIngredient.get(id) ?? [],
          rule: rule ? {
            supplier: String(rule.supplier),
            packs: Number(rule.packs),
            orderLimit: amount(rule.order_limit),
            enabled: rule.enabled === true,
          } : null,
        };
      }),
      legacyRules,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not load café settings:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Café settings could not be loaded. Check the server setup." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to update café settings." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit valid café settings." }, { status: 400 });
  }
  const parsed = z.union([
    policySchema,
    pauseSchema,
    reorderRuleSchema,
    profileSchema,
    supplierSchema,
  ]).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The café settings are invalid." }, { status: 400 });
  }

  try {
    const db = inventoryClient();
    if (parsed.data.operation === "save-policy") {
      const { error } = await db.from("cafe_spend_policy").update({
        auto_order_limit: parsed.data.autoOrderLimit,
        daily_limit: parsed.data.dailyLimit,
        weekly_limit: parsed.data.weeklyLimit,
      }).eq("id", 1);
      if (error) throw new Error(`Could not save the spend policy: ${error.message}`);
    } else if (parsed.data.operation === "set-pause") {
      const { error } = await db.from("cafe_settings")
        .update({ automation_paused: parsed.data.paused, updated_at: new Date().toISOString() })
        .eq("id", 1);
      if (error) throw new Error(`Could not update the automation pause: ${error.message}`);
    } else if (parsed.data.operation === "save-reorder-rule") {
      const [ingredient, offer] = await Promise.all([
        db.from("inventory").select("ingredient_id").eq("ingredient_id", parsed.data.ingredientId).maybeSingle(),
        db.from("supplier_prices").select("supplier")
          .eq("ingredient_id", parsed.data.ingredientId)
          .eq("supplier", parsed.data.supplier)
          .maybeSingle(),
      ]);
      if (ingredient.error || offer.error) {
        throw new Error(`Could not verify the reorder rule: ${ingredient.error?.message ?? offer.error?.message}`);
      }
      if (!ingredient.data || !offer.data || isDemoSupplier(offer.data.supplier)) {
        return NextResponse.json({ error: "Choose an ingredient and supplier from the live café data." }, { status: 400 });
      }
      const { error } = await db.from("cafe_reorder_rules").upsert({
        ingredient_id: Number(parsed.data.ingredientId),
        supplier: parsed.data.supplier,
        packs: parsed.data.packs,
        order_limit: parsed.data.orderLimit,
        enabled: parsed.data.enabled,
      }, { onConflict: "ingredient_id" });
      if (error) throw new Error(`Could not save the reorder rule: ${error.message}`);
    } else if (parsed.data.operation === "save-profile") {
      if (parsed.data.closeTime <= parsed.data.openTime || !validRushWindows(parsed.data.rushWindows)) {
        return NextResponse.json({ error: "Café hours and rush windows must be valid and non-overlapping." }, { status: 400 });
      }
      if (parsed.data.ownerEmail && !isEmail(parsed.data.ownerEmail)) {
        return NextResponse.json({ error: "Enter a valid owner email address." }, { status: 400 });
      }
      const { error } = await db.from("cafe_settings").update({
        cafe_name: parsed.data.cafeName,
        owner_name: parsed.data.ownerName || null,
        owner_email: parsed.data.ownerEmail || null,
        open_time: parsed.data.openTime,
        close_time: parsed.data.closeTime,
        rush_windows: parsed.data.rushWindows,
        updated_at: new Date().toISOString(),
      }).eq("id", 1);
      if (error) throw new Error(`Could not save the café profile: ${error.message}`);
    } else {
      if (parsed.data.contactEmail && !isEmail(parsed.data.contactEmail)) {
        return NextResponse.json({ error: "Enter a valid supplier contact email or leave it blank." }, { status: 400 });
      }
      if (Boolean(parsed.data.deliveryWindowStart) !== Boolean(parsed.data.deliveryWindowEnd)
        || (parsed.data.deliveryWindowStart && parsed.data.deliveryWindowStart >= parsed.data.deliveryWindowEnd)) {
        return NextResponse.json({ error: "Enter both delivery-window times, with the start before the end, or clear both." }, { status: 400 });
      }
      if (isDemoSupplier(parsed.data.name)) {
        return NextResponse.json({ error: "Demo suppliers cannot be edited as live suppliers." }, { status: 400 });
      }
      const { data, error } = await db.from("suppliers").update({
        contact_email: parsed.data.contactEmail || null,
        lead_time_days: parsed.data.leadTimeDays,
        order_cutoff: parsed.data.orderCutoff || null,
        delivery_window_start: parsed.data.deliveryWindowStart || null,
        delivery_window_end: parsed.data.deliveryWindowEnd || null,
        active: parsed.data.active,
      }).eq("name", parsed.data.name).select("name").maybeSingle();
      if (error || !data) throw new Error(`Could not save the supplier profile: ${error?.message ?? "No supplier row returned"}`);
    }

    return NextResponse.json({ status: "saved" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Could not update café settings:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Café settings could not be saved. Check the current database values and try again." }, { status: 500 });
  }
}
