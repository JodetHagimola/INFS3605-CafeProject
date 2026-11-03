import { checkAgentPasscode } from "@/lib/agent/auth";
import { runAgent } from "@/lib/agent/runtime";
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

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a short request, a valid date, and a holiday choice." },
      { status: 400 },
    );
  }

  try {
    const result = await runAgent({
      request: parsed.data.request,
      forecastDate: parsed.data.forecastDate,
      isPublicHoliday: parsed.data.isPublicHoliday,
    });
    return NextResponse.json(result);
  } catch (error) {
    console.error("The agent request failed:", error instanceof Error ? error.name : "Unknown error");
    const message = error instanceof Error
      && error.message === "The Gemini API key is not configured on the server."
      ? error.message
      : "The agent could not complete the request. Check the sales and inventory setup, then try again.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
