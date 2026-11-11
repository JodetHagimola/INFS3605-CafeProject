import "server-only";

import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { approvalDetailsSchema, approvalItemSchema, type ApprovalItem } from "./approval-schema";

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

export class RestockApprovalValidationError extends Error {}
export class RestockApprovalConflictError extends Error {}

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
  const { data, error } = await inventoryClient().rpc("record_human_approval_decision", {
    p_approval_id: input.id,
    p_decision: input.status,
    p_reviewer_note: input.reviewerNote,
  });
  if (error) {
    console.error("Could not decide an approval inbox item:", error.message);
    throw new Error("The approval decision could not be saved.");
  }
  return data === true ? "updated" : "not-pending";
}

export async function createRestockApproval(input: {
  actionId: string;
  briefDate: string;
  ingredientId: string;
  ingredient: string;
  quantity: number;
  unit: string;
  supplier: string;
  reason: string;
  standingRule?: { id: string; name: string; maximumTotal: number };
}): Promise<{ id: string; estimatedCost: number; alreadyApproved: boolean }> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0 || input.quantity > 100_000) {
    throw new RestockApprovalValidationError("Enter a whole-number restock quantity between 1 and 100,000.");
  }

  const db = inventoryClient();
  const [existingResult, priceResult] = await Promise.all([
    db.from("approval_inbox")
      .select("id,status,details")
      .eq("action", "place_or_send_order")
      .contains("details", { briefDate: input.briefDate, ingredientId: input.ingredientId })
      .limit(1)
      .maybeSingle(),
    db.from("supplier_prices")
      .select("price,minimum_order")
      .eq("supplier", input.supplier)
      .eq("ingredient_id", input.ingredientId)
      .maybeSingle(),
  ]);
  if (existingResult.error) {
    console.error("Could not check for an existing restock approval:", existingResult.error.message);
    throw new Error("Existing restock approvals could not be checked.");
  }
  if (existingResult.data) {
    if (existingResult.data.status === "approved") {
      const details = existingResult.data.details;
      const storedCost = details && typeof details === "object" && "estimatedCost" in details
        ? Number(details.estimatedCost)
        : NaN;
      return {
        id: String(existingResult.data.id),
        estimatedCost: Number.isFinite(storedCost) && storedCost >= 0 ? storedCost : 0,
        alreadyApproved: true,
      };
    }
    throw new RestockApprovalConflictError("A restock decision already exists for this ingredient today.");
  }
  if (priceResult.error || !priceResult.data) {
    console.error("Could not verify the selected restock supplier:", priceResult.error?.message ?? "No supplier price found");
    throw new Error("The selected supplier price could not be verified.");
  }

  const price = Number(priceResult.data.price);
  const minimumOrder = Number(priceResult.data.minimum_order);
  if (!Number.isFinite(price) || price < 0 || !Number.isFinite(minimumOrder) || minimumOrder < 0) {
    console.error("The selected supplier returned invalid price or minimum-order data.");
    throw new Error("The selected supplier price could not be verified.");
  }
  if (input.quantity < minimumOrder) {
    throw new RestockApprovalValidationError(`The selected supplier requires a minimum order of ${minimumOrder} ${input.unit}.`);
  }
  const estimatedCost = Math.round(input.quantity * price * 100) / 100;
  if (input.standingRule && estimatedCost > input.standingRule.maximumTotal) {
    throw new Error("The current supplier price exceeds the standing rule limit; manual approval is required.");
  }
  const details = approvalDetailsSchema.parse({
    briefDate: input.briefDate,
    briefActionId: input.actionId,
    ingredientId: input.ingredientId,
    ingredient: input.ingredient,
    quantity: input.quantity,
    unit: input.unit,
    supplier: input.supplier,
    estimatedCost,
    reason: input.reason.slice(0, 1000),
    approvalSource: input.standingRule ? "standing_rule" : "today_brief",
    ...(input.standingRule ? {
      standingRuleId: input.standingRule.id,
      standingRuleName: input.standingRule.name,
    } : {}),
  });
  const reviewedAt = new Date().toISOString();
  const reviewerNote = input.standingRule
    ? `Automatically approved by standing rule "${input.standingRule.name}". No order was placed and no supplier was contacted.`
    : "Approved from Today's Brief. No order was placed and no supplier was contacted.";
  const { data, error } = await db.from("approval_inbox")
    .insert({
      action: "place_or_send_order",
      summary: `${input.ingredient}: restock ${input.quantity} ${input.unit} from ${input.supplier}`,
      details,
      status: "approved",
      reviewed_at: reviewedAt,
      reviewer_note: reviewerNote.slice(0, 500),
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("Could not record a restock approval:", error?.message ?? "No approval row returned");
    throw new Error("The restock approval could not be saved.");
  }
  return { id: String(data.id), estimatedCost, alreadyApproved: false };
}
