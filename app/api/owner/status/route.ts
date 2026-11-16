import { NextResponse } from "next/server";
import { hasAgentSession } from "@/lib/agent/auth";
import { ownerDockStatus } from "@/lib/owner-communication";

export const runtime = "nodejs";

export async function GET() {
  if (!await hasAgentSession()) {
    return NextResponse.json({ error: "Please sign in to view owner status." }, { status: 401 });
  }
  try {
    return NextResponse.json(await ownerDockStatus(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Could not load owner status:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Owner status could not be loaded." }, { status: 500 });
  }
}
