import { approveDraft } from "@/lib/agent/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";

const approvalSchema = z.object({
  passcode: z.string().min(1).max(128),
  draftId: z.string().min(1).max(64),
}).strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid approval." }, { status: 400 });
  }

  const parsed = approvalSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Enter the passcode for the draft approval." }, { status: 400 });
  }

  try {
    const result = await approveDraft(parsed.data.passcode, parsed.data.draftId);
    if (result.error) {
      return NextResponse.json({ error: result.error }, {
        status: result.error === "The passcode does not match." ? 401 : 400,
      });
    }
    return NextResponse.json({ status: result.status });
  } catch {
    return NextResponse.json(
      { error: "The draft could not be approved. Check the passcode and Supabase settings." },
      { status: 500 },
    );
  }
}
