import { NextResponse } from "next/server";
import { z } from "zod";
import { getAgentActivity } from "@/lib/agent/activity-log";
import { checkAgentPasscode } from "@/lib/agent/auth";

export const runtime = "nodejs";

const requestSchema = z.object({
  passcode: z.string().min(1).max(128),
}).strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid activity request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "A valid agent passcode is required." }, { status: 401 });
  }
  try {
    if (!checkAgentPasscode(parsed.data.passcode)) {
      return NextResponse.json({ error: "The passcode does not match." }, { status: 401 });
    }
  } catch {
    return NextResponse.json({ error: "The agent passcode is not configured on the server." }, { status: 500 });
  }

  try {
    return NextResponse.json({ items: await getAgentActivity() });
  } catch {
    return NextResponse.json({ error: "Agent activity could not be loaded. Check the Supabase setup." }, { status: 500 });
  }
}
