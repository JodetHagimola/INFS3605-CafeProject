import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import { decideApproval, editApproval, getApprovalInbox } from "@/lib/agent/approval";
import { getAgentActivity } from "@/lib/agent/activity-log";
import { approvalDetailsSchema } from "@/lib/agent/approval-schema";

export const runtime = "nodejs";

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

    const result = await decideApproval({
      id: parsed.data.id,
      status: parsed.data.decision,
      reviewerNote: parsed.data.reviewerNote,
    });
    return result === "updated"
      ? NextResponse.json({ status: parsed.data.decision })
      : NextResponse.json({ error: "This item is no longer pending approval." }, { status: 409 });
  } catch {
    return NextResponse.json({ error: "The approval inbox could not be updated. Check the Supabase setup." }, { status: 500 });
  }
}
