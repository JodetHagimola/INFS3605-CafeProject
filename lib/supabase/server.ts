import "server-only";
import { createClient } from "@supabase/supabase-js";

export type OrderRow = {
  id: string | number;
  created_at: string | null;
  [column: string]: unknown;
};

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;

  if (!url || !secretKey) {
    return null;
  }

  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

export async function getOrders(): Promise<
  | { orders: OrderRow[]; error: null }
  | { orders: []; error: string }
> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      orders: [],
      error: "Add SUPABASE_URL and SUPABASE_SECRET_KEY to your .env.local file.",
    };
  }

  const { data, error } = await supabase
    .from("order")
    .select("*")
    .not("id", "is", null)
    .not("created_at", "is", null)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("Could not load orders:", error.message);
    return { orders: [], error: "Orders could not be loaded. Check your Supabase settings and table permissions." };
  }

  return { orders: (data ?? []) as OrderRow[], error: null };
}

export async function createOrder(): Promise<
  | { order: OrderRow; error: null }
  | { order: null; error: string }
> {
  const supabase = getSupabaseClient();
  if (!supabase) {
    return {
      order: null,
      error: "Add SUPABASE_URL and SUPABASE_SECRET_KEY to your .env.local file.",
    };
  }

  const { data, error } = await supabase
    .from("order")
    .insert({})
    .select("*")
    .single();

  if (error || !data) {
    console.error("Could not create order:", error?.message ?? "No row returned");
    return {
      order: null,
      error: "The order could not be saved. Check your Supabase settings and table permissions.",
    };
  }

  return { order: data as OrderRow, error: null };
}
