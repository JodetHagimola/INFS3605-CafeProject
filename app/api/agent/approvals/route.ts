import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import {
  createRestockApproval,
  decideApproval,
  editApproval,
  getApprovalInbox,
  RestockApprovalConflictError,
  RestockApprovalValidationError,
} from "@/lib/agent/approval";
import { getAgentActivity } from "@/lib/agent/activity-log";
import { approvalDetailsSchema } from "@/lib/agent/approval-schema";
import { isValidISODate } from "@/lib/agent/date";
import { getDailyBrief } from "@/lib/agent/daily-brief";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    operation: z.literal("list"),
  }).strict(),
  z.object({
    operation: z.literal("edit"),
    id: z.string().uuid(),
    summary: z.string().trim().min(1).max(500),
    details: approvalDetailsSchema,
  }).strict(),
  z.object({
    operation: z.literal("approve-restock"),
    actionId: z.string().uuid(),
    date: z.string().refine(isValidISODate),
    quantity: z.number().int().positive().max(100_000),
  }).strict(),
  z.object({
    operation: z.literal("decide"),
    id: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reviewerNote: z.string().trim().max(500),
  }).strict(),
]);

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to manage approvals." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid approval request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The approval request is invalid." }, { status: 400 });
  }

  try {
    if (parsed.data.operation === "list") {
      const [items, activity] = await Promise.all([getApprovalInbox(), getAgentActivity()]);
      const flags = activity.filter((entry) => entry.outcome === "blocked" || entry.outcome === "error");
      return NextResponse.json({ items, flags });
    }
    if (parsed.data.operation === "edit") {
      const result = await editApproval({
        id: parsed.data.id,
        summary: parsed.data.summary,
        details: parsed.data.details,
      });
      return result === "updated"
        ? NextResponse.json({ status: "updated" })
        : NextResponse.json({ error: "This item is no longer pending approval." }, { status: 409 });
    }
    if (parsed.data.operation === "approve-restock") {
      const restockRequest = parsed.data;
      try {
        const brief = await getDailyBrief({ date: restockRequest.date });
        const item = brief.stock_items.find((stockItem) => stockItem.approve_action_id === restockRequest.actionId);
        if (!item) {
          return NextResponse.json({ error: "This restock suggestion is no longer available. Refresh today's brief." }, { status: 409 });
        }
        if (!item.suggested_order.supplier || item.suggested_order.quantity === null) {
          return NextResponse.json({ error: "This restock cannot be approved until its quantity and supplier are verified." }, { status: 409 });
        }

        const result = await createRestockApproval({
          actionId: restockRequest.actionId,
          briefDate: restockRequest.date,
          ingredientId: item.ingredient_id,
          ingredient: item.name,
          quantity: restockRequest.quantity,
          unit: item.suggested_order.unit,
          supplier: item.suggested_order.supplier,
          reason: item.why,
        });
        return NextResponse.json({
          status: "approved",
          estimatedCost: result.estimatedCost,
          alreadyApproved: result.alreadyApproved,
          note: "Approval recorded. No order was placed and no supplier was contacted.",
        });
      } catch (error) {
        console.error("Could not verify or record Today's Brief restock approval:", error);
        const message = error instanceof RestockApprovalValidationError
          || error instanceof RestockApprovalConflictError
          ? error.message
          : error instanceof Error && error.message.startsWith("Today's brief")
            ? error.message
            : "Today's brief could not be verified; no approval was recorded.";
        const status = error instanceof RestockApprovalValidationError
          ? 400
          : error instanceof RestockApprovalConflictError
            ? 409
            : 500;
        return NextResponse.json({ error: message }, { status });
      }
    }

    const result = await decideApproval({
      id: parsed.data.id,
      status: parsed.data.decision,
      reviewerNote: parsed.data.reviewerNote,
    });
    return result === "updated"
      ? NextResponse.json({ status: parsed.data.decision })
      : NextResponse.json({ error: "This item is no longer pending approval." }, { status: 409 });
  } catch (error) {
    console.error("Could not update the approval inbox:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "The approval inbox could not be updated. Check the Supabase setup." }, { status: 500 });
  }
}
