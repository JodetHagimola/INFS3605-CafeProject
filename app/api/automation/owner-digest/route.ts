import { NextResponse } from "next/server";
import { queueOwnerDigest } from "@/lib/owner-communication";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "The owner digest scheduler is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  if (process.env.OWNER_DIGEST_ENABLED !== "true") {
    return NextResponse.json({ status: "disabled" }, { headers: { "Cache-Control": "no-store" } });
  }

  try {
    return NextResponse.json(await queueOwnerDigest(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("Could not queue the owner digest:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "The owner digest could not be queued." }, { status: 500 });
  }
}
