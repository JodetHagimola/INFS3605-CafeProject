import { generateText } from "ai";
import { NextResponse } from "next/server";
import { hasAgentSession } from "@/lib/agent/auth";
import { getGeminiModel, getGeminiModelId } from "@/lib/agent/model";
import { inventoryClient } from "@/lib/inventory/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const tableProbes = [
  ["ingredients", "ingredient_id,ingredient_name,unit"],
  ["inventory", "ingredient_id,quantity_in_stock,minimum_stock,last_updated"],
  ["recipes", "product_name,ingredient_id,quantity_required"],
  ["sales_history", "sales_date,product_name,units_sold,is_public_holiday,source"],
  ["incoming_deliveries", "delivery_id,ingredient_id,quantity,expected_date"],
  ["delivery_receipts", "delivery_id,received_quantity,received_at"],
  ["supplier_prices", "supplier,ingredient_id,price,delivery_time,minimum_order"],
  ["daily_briefs", "brief_date,greeting,status_line,items,all_clear,details,generated_at"],
  ["agent_activity", "id,tool,input_summary,outcome,reason,created_at"],
  ["draft_orders", "id,status,forecast_date,forecast,lines,flags,data_used"],
  ["approval_inbox", "id,action,summary,details,status,created_at,reviewed_at,reviewer_note"],
] as const;

const legacyPolicySources = [
  { name: "standing_rules", active: false },
  { name: "rules (decision limits)", active: false },
] as const;

function safeError(error: unknown): { name: string; message: string } {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message: message
      .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/(api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]")
      .slice(0, 1000),
  };
}

export async function GET() {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to run the agent health check." }, { status: 401 });
  }

  const env = {
    googleApiKey: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    geminiModel: Boolean(process.env.GEMINI_MODEL?.trim()),
    supabaseUrl: Boolean(process.env.SUPABASE_URL),
    supabaseServerKey: Boolean(process.env.SUPABASE_SECRET_KEY),
    agentPasscode: Boolean(process.env.AGENT_PASSCODE),
  };

  let gemini: { ok: boolean; model: string; error?: ReturnType<typeof safeError> };
  const model = getGeminiModelId();
  try {
    const result = await generateText({
      model: getGeminiModel(),
      prompt: "Reply with OK.",
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(12_000),
    });
    gemini = { ok: Boolean(result.text.trim()), model };
  } catch (error) {
    gemini = { ok: false, model, error: safeError(error) };
  }

  const tables = await Promise.all(tableProbes.map(async ([table, columns]) => {
    try {
      const { count, error } = await inventoryClient()
        .from(table)
        .select(columns, { count: "exact", head: true })
        .limit(0);
      if (error) {
        console.error(`Agent health probe failed for ${table}:`, error.message);
        return { table, ok: false, error: error.message };
      }
      return { table, ok: true, rowCount: count };
    } catch (error) {
      const details = safeError(error);
      console.error(`Agent health probe failed for ${table}:`, details);
      return { table, ok: false, error: details.message };
    }
  }));

  return NextResponse.json({
    environment: env,
    gemini,
    tables,
    legacyPolicySources,
    date: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date()),
    commit: process.env.VERCEL_GIT_COMMIT_SHA ?? null,
  });
}
