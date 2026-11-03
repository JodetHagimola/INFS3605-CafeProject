import { NextResponse } from "next/server";
import { z } from "zod";
import { checkAgentPasscode } from "@/lib/agent/auth";
import { decideApproval, editApproval, getApprovalInbox } from "@/lib/agent/approval";
import { getAgentActivity } from "@/lib/agent/activity-log";
import { approvalDetailsSchema } from "@/lib/agent/approval-schema";

export const runtime = "nodejs";

const requestSchema = z.discriminatedUnion("operation", [
  z.object({
    passcode: z.string().min(1).max(128),
    operation: z.literal("verify"),
  }).strict(),
  z.object({
    passcode: z.string().min(1).max(128),
    operation: z.literal("list"),
  }).strict(),
  z.object({
    passcode: z.string().min(1).max(128),
    operation: z.literal("edit"),
    id: z.string().uuid(),
    summary: z.string().trim().min(1).max(500),
    details: approvalDetailsSchema,
  }).strict(),
  z.object({
    passcode: z.string().min(1).max(128),
    operation: z.literal("decide"),
    id: z.string().uuid(),
    decision: z.enum(["approved", "rejected"]),
    reviewerNote: z.string().trim().max(500),
  }).strict(),
]);

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid approval request." }, { status: 400 });
  }

  const suppliedPasscode = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).passcode
    : undefined;
  if (typeof suppliedPasscode !== "string" || !suppliedPasscode || suppliedPasscode.length > 128) {
    return NextResponse.json({ error: "A valid agent passcode is required." }, { status: 401 });
  }
  try {
    if (!checkAgentPasscode(suppliedPasscode)) {
      return NextResponse.json({ error: "The passcode does not match." }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "The agent passcode is not configured on the server." }, { status: 500 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The approval request is invalid." }, { status: 400 });
  }

  try {
    if (parsed.data.operation === "verify") {
      return NextResponse.json({ status: "verified" });
    }
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
