import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { OrderRequestItem, OrderRequestStatus } from "./model";

export type OrderRequest = {
  id: string;
  chefName: string;
  neededBy: string;
  notes: string;
  items: OrderRequestItem[];
  status: OrderRequestStatus;
  approverName: string | null;
  decisionNote: string | null;
  createdAt: string;
  decidedAt: string | null;
};

type OrderRequestInput = Pick<OrderRequest, "chefName" | "neededBy" | "notes" | "items">;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secretKey) return null;

  return createClient(url, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function mapRequest(row: Record<string, unknown>): OrderRequest {
  return {
    id: String(row.id),
    chefName: String(row.chef_name),
    neededBy: String(row.needed_by),
    notes: typeof row.notes === "string" ? row.notes : "",
    items: row.items as OrderRequestItem[],
    status: row.status as OrderRequestStatus,
    approverName: typeof row.approver_name === "string" ? row.approver_name : null,
    decisionNote: typeof row.decision_note === "string" ? row.decision_note : null,
    createdAt: String(row.created_at),
    decidedAt: typeof row.decided_at === "string" ? row.decided_at : null,
  };
}

export async function getOrderRequests(): Promise<
  | { requests: OrderRequest[]; error: null }
  | { requests: []; error: string }
> {
  try {
    const db = getClient();
    if (!db) {
      return {
        requests: [],
        error: "Add SUPABASE_URL and SUPABASE_SECRET_KEY, then run supabase/order-requests.sql in the Supabase SQL Editor.",
      };
    }

    const rows: Record<string, unknown>[] = [];
    for (let offset = 0; ; offset += 500) {
      const { data, error } = await db
        .from("order_requests")
        .select("id,chef_name,needed_by,notes,items,status,approver_name,decision_note,created_at,decided_at")
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(offset, offset + 499);

      if (error) throw error;
      rows.push(...(data as unknown as Record<string, unknown>[]));
      if (data.length < 500) break;
    }

    return { requests: rows.map(mapRequest), error: null };
  } catch (error) {
    console.error("Could not load order requests:", error);
    return {
      requests: [],
      error: "Order requests could not be loaded. Confirm the Supabase setup SQL has been run and check server permissions.",
    };
  }
}

export async function createOrderRequest(input: OrderRequestInput): Promise<{ error: string | null }> {
  try {
    const db = getClient();
    if (!db) {
      return { error: "Supabase is not configured. Add the server settings and run the order requests setup SQL." };
    }

    const { error } = await db.from("order_requests").insert({
      chef_name: input.chefName,
      needed_by: input.neededBy,
      notes: input.notes,
      items: input.items,
    });

    if (error) {
      console.error("Could not submit order request:", error.message);
      return { error: "The order could not be submitted. Confirm the Supabase setup SQL has been run and try again." };
    }
  } catch (error) {
    console.error("Could not submit order request:", error);
    return { error: "The order could not be submitted. Confirm the Supabase setup SQL has been run and try again." };
  }

  return { error: null };
}

export async function decideOrderRequest(input: {
  id: string;
  status: Exclude<OrderRequestStatus, "pending">;
  approverName: string;
  decisionNote: string;
}): Promise<"updated" | "already-decided" | "error"> {
  try {
    const db = getClient();
    if (!db) return "error";

    const { data, error } = await db
      .from("order_requests")
      .update({
        status: input.status,
        approver_name: input.approverName,
        decision_note: input.decisionNote,
        decided_at: new Date().toISOString(),
      })
      .eq("id", input.id)
      .eq("status", "pending")
      .select("id")
      .maybeSingle();

    if (error) {
      console.error("Could not decide order request:", error.message);
      return "error";
    }

    return data ? "updated" : "already-decided";
  } catch (error) {
    console.error("Could not decide order request:", error);
    return "error";
  }
}
