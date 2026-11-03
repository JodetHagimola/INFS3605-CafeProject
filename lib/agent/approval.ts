import "server-only";

import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { approvalItemSchema, type ApprovalItem } from "./approval-schema";

const rowSchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  summary: z.string(),
  details: z.record(z.string(), z.unknown()),
  status: z.string(),
  created_at: z.string(),
  reviewed_at: z.string().nullable(),
  reviewer_note: z.string().nullable(),
});

function mapApproval(row: unknown): ApprovalItem {
  const parsed = rowSchema.safeParse(row);
  if (!parsed.success) throw new Error("An approval inbox record is invalid.");
  return approvalItemSchema.parse({
    id: parsed.data.id,
    action: parsed.data.action,
    summary: parsed.data.summary,
    details: parsed.data.details,
    status: parsed.data.status,
    createdAt: parsed.data.created_at,
    reviewedAt: parsed.data.reviewed_at,
    reviewerNote: parsed.data.reviewer_note,
  });
}

export async function getApprovalInbox(): Promise<ApprovalItem[]> {
  const { data, error } = await inventoryClient()
    .from("approval_inbox")
    .select("id,action,summary,details,status,created_at,reviewed_at,reviewer_note")
    .order("created_at", { ascending: false });
  if (error) {
    console.error("Could not read the approval inbox:", error.message);
    throw new Error("The approval inbox could not be loaded. Check the Supabase setup.");
  }
  return (data ?? []).map(mapApproval);
}

export async function editApproval(input: {
  id: string;
  summary: string;
  details: Record<string, string | number | boolean | null>;
}): Promise<"updated" | "not-pending"> {
  const { data, error } = await inventoryClient()
    .from("approval_inbox")
    .update({ summary: input.summary, details: input.details })
    .eq("id", input.id)
    .eq("status", "pending_approval")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Could not edit an approval inbox item:", error.message);
    throw new Error("The approval item could not be edited.");
  }
  return data ? "updated" : "not-pending";
}

export async function decideApproval(input: {
  id: string;
  status: "approved" | "rejected";
  reviewerNote: string;
}): Promise<"updated" | "not-pending"> {
  const { data, error } = await inventoryClient()
    .from("approval_inbox")
    .update({
      status: input.status,
      reviewer_note: input.reviewerNote,
      reviewed_at: new Date().toISOString(),
    })
    .eq("id", input.id)
    .eq("status", "pending_approval")
    .select("id")
    .maybeSingle();
  if (error) {
    console.error("Could not decide an approval inbox item:", error.message);
    throw new Error("The approval decision could not be saved.");
  }
  return data ? "updated" : "not-pending";
}
