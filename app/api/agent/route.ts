import { runAgent } from "@/lib/agent/server";
import { NextResponse } from "next/server";
import { z } from "zod";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  passcode: z.string().min(1).max(128),
  request: z.string().trim().min(1).max(1000),
  forecastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  isPublicHoliday: z.boolean(),
}).strict();

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid request." }, { status: 400 });
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a passcode, a short request, a valid date, and a holiday choice." },
      { status: 400 },
    );
  }

  try {
    const result = await runAgent(parsed.data);
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "The agent could not complete the request.";
    const status = message === "The passcode does not match." ? 401 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
