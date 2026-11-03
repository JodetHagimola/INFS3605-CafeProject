import { NextResponse } from "next/server";
import { getAgentActivity } from "@/lib/agent/activity-log";
import { hasAgentSession } from "@/lib/agent/auth";
import { getApprovalInbox } from "@/lib/agent/approval";

export const runtime = "nodejs";

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to view agent activity." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid activity request." }, { status: 400 });
  }

  if (body !== null && (typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).length > 0)) {
    return NextResponse.json({ error: "The activity request is invalid." }, { status: 400 });
  }

  try {
    const [items, approvals] = await Promise.all([getAgentActivity(), getApprovalInbox()]);
    return NextResponse.json({ items, approvals });
  } catch {
    return NextResponse.json({ error: "Agent activity could not be loaded. Check the Supabase setup." }, { status: 500 });
  }
}
