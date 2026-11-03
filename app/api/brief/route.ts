import { NextResponse } from "next/server";
import { z } from "zod";
import { hasAgentSession } from "@/lib/agent/auth";
import { getDailyBrief } from "@/lib/agent/daily-brief";

export const runtime = "nodejs";
export const maxDuration = 60;

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsedDate = new Date(`${value}T00:00:00.000Z`);
  return parsedDate.toISOString().slice(0, 10) === value;
}, { message: "The brief date is invalid." });

const requestSchema = z.object({
  refresh: z.boolean().optional(),
  date: dateSchema.optional(),
}).strict();

export async function POST(request: Request) {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to refresh today's brief." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Please submit a valid brief request." }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "The brief request is invalid." }, { status: 400 });
  }

  try {
    return NextResponse.json(await getDailyBrief({
      refresh: parsed.data.refresh,
      date: parsed.data.date,
    }));
  } catch (error) {
    console.error("Could not prepare today's brief:", error instanceof Error ? error.name : "Unknown error");
    const message = error instanceof Error
      && (error.message === "The requested brief date is invalid."
        || error.message === "The Gemini API key is not configured on the server."
        || error.message.startsWith("Gemini rejected the configured model."))
      ? error.message
      : error instanceof Error && error.message.startsWith("Today's")
        ? error.message
        : "Today's brief could not be prepared. Please try again later.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
