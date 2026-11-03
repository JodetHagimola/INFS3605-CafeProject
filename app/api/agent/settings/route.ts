import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";

export const runtime = "nodejs";

const ruleInputSchema = z.object({
  operation: z.literal("save"),
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(160),
  ingredientIds: z.array(z.string().regex(/^\d+$/).max(30)).min(1).max(50),
  supplier: z.string().trim().min(1).max(120),
  maximumTotal: z.number().finite().positive().max(1_000_000_000),
}).strict().refine((value) => new Set(value.ingredientIds).size === value.ingredientIds.length, {
  message: "Ingredient IDs must be unique.",
});

const toggleSchema = z.object({
  operation: z.literal("toggle"),
  id: z.string().uuid(),
  enabled: z.boolean(),
}).strict();

export async function GET() {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to view agent settings." }, { status: 401 });
  }

  try {
    const db = inventoryClient();
    const [rulesResult, ingredientsResult, suppliersResult] = await Promise.all([
      db.from("standing_rules")
        .select("id,name,enabled,ingredient_ids,supplier,maximum_total,updated_at")
        .order("created_at", { ascending: false }),
      db.from("ingredients").select("ingredient_id,ingredient_name,unit").order("ingredient_name"),
      db.from("supplier_prices").select("supplier"),
    ]);
    const failedResult = [rulesResult, ingredientsResult, suppliersResult].find((result) => result.error);
    if (failedResult?.error) {
      console.error("Could not load agent settings:", failedResult.error.message);
      return NextResponse.json({ error: "Agent settings could not be loaded. Check the Supabase setup." }, { status: 500 });
    }

    return NextResponse.json({
      rules: rulesResult.data ?? [],
      ingredients: ingredientsResult.data ?? [],
      suppliers: [...new Set((suppliersResult.data ?? []).map((row) => row.supplier).filter(Boolean))]
        .sort((left, right) => left.localeCompare(right)),
    });
  } catch (error) {
    console.error("Could not load agent settings:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Agent settings could not be loaded. Check the server setup." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to update agent settings." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit valid agent settings." }, { status: 400 });
  }
  const parsed = z.union([ruleInputSchema, toggleSchema]).safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The agent settings are invalid." }, { status: 400 });
  }

  try {
    const db = inventoryClient();
    if (parsed.data.operation === "toggle") {
      const { data, error } = await db.from("standing_rules")
        .update({ enabled: parsed.data.enabled, updated_at: new Date().toISOString() })
        .eq("id", parsed.data.id)
        .select("id")
        .maybeSingle();
      if (error || !data) {
        console.error("Could not update a standing rule:", error?.message ?? "No rule found");
        return NextResponse.json({ error: "The standing rule could not be updated." }, { status: 500 });
      }
      return NextResponse.json({ status: "updated" });
    }

    const [ingredientsResult, supplierResult] = await Promise.all([
      db.from("ingredients")
        .select("ingredient_id")
        .in("ingredient_id", parsed.data.ingredientIds),
      db.from("supplier_prices")
        .select("supplier")
        .eq("supplier", parsed.data.supplier)
        .limit(1)
        .maybeSingle(),
    ]);
    if (ingredientsResult.error || supplierResult.error) {
      const error = ingredientsResult.error ?? supplierResult.error;
      console.error("Could not verify standing rule selections:", error?.message ?? "No database response");
      return NextResponse.json({ error: "The standing rule selections could not be verified." }, { status: 500 });
    }
    if ((ingredientsResult.data ?? []).length !== parsed.data.ingredientIds.length) {
      return NextResponse.json({ error: "One or more selected ingredients could not be found." }, { status: 400 });
    }
    if (!supplierResult.data) {
      return NextResponse.json({ error: "Choose a supplier listed in the café's supplier data." }, { status: 400 });
    }

    const values = {
      name: parsed.data.name,
      ingredient_ids: parsed.data.ingredientIds,
      supplier: parsed.data.supplier,
      maximum_total: parsed.data.maximumTotal,
      updated_at: new Date().toISOString(),
    };
    const result = parsed.data.id
      ? await db.from("standing_rules").update(values).eq("id", parsed.data.id).select("id").maybeSingle()
      : await db.from("standing_rules").insert({ ...values, enabled: true }).select("id").single();
    if (result.error || !result.data) {
      console.error("Could not save a standing rule:", result.error?.message ?? "No rule row returned");
      return NextResponse.json({ error: "The standing rule could not be saved." }, { status: 500 });
    }
    return NextResponse.json({ status: "saved" });
  } catch (error) {
    console.error("Could not update agent settings:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Agent settings could not be updated. Check the server setup." }, { status: 500 });
  }
}
