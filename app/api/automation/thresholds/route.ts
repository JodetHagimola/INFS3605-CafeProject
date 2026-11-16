import { NextResponse } from "next/server";
import { recalculateAutoThresholds } from "@/lib/inventory/thresholds";
import { trackAutomationCycle } from "@/lib/automation/run-tracker";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "The threshold scheduler is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  if (!inventoryWritesEnabled()) {
    return NextResponse.json({ error: "Inventory writes are disabled by server policy." }, { status: 503 });
  }

  try {
    const result = await trackAutomationCycle("thresholds", recalculateAutoThresholds);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Automatic threshold recalculation failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "Automatic thresholds could not be recalculated." }, { status: 500 });
  }
}
