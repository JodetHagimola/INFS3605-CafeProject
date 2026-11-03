import "server-only";

import { createClient } from "@supabase/supabase-js";
import { draftOrderSchema, type DraftOrderRecord } from "./draft-schema";

export type DraftOrder = DraftOrderRecord;

function createSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing.");
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getLatestDraft(): Promise<{
  draft: DraftOrder | null;
  error: string | null;
}> {
  try {
    const { data, error } = await createSupabaseClient()
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

    const parsed = draftOrderSchema.safeParse({
      id: String(data.id),
      status: data.status,
      forecastDate: String(data.forecast_date),
      createdAt: String(data.created_at),
      forecast: data.forecast,
      lines: data.lines,
      flags: data.flags,
      dataUsed: data.data_used,
    });
    if (!parsed.success) {
      console.error("The latest draft failed schema validation:", parsed.error.issues.length);
      return { draft: null, error: "The latest draft has invalid stored data and cannot be displayed." };
    }
    return { draft: parsed.data, error: null };
  } catch {
    return { draft: null, error: "Add the Supabase server settings and run the draft setup SQL." };
  }
}
