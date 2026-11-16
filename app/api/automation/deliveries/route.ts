import { NextResponse } from "next/server";
import { runDeliveryCycle } from "@/lib/automation/delivery-cycle";
import { trackAutomationCycle } from "@/lib/automation/run-tracker";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";

export const runtime = "nodejs";
export const maxDuration = 30;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "The delivery scheduler is not configured." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Not authorized." }, { status: 401 });
  }
  if (!inventoryWritesEnabled()) {
    return NextResponse.json({ error: "Inventory writes are disabled by server policy." }, { status: 503 });
  }
  if (process.env.DELIVERY_AUTOMATION_ENABLED !== "true") {
    return NextResponse.json(
      { status: "disabled", message: "Delivery automation is disabled." },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const result = await trackAutomationCycle("deliveries", runDeliveryCycle);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Delivery automation cycle failed:", error instanceof Error ? error.message : "Unknown error");
    return NextResponse.json({ error: "The delivery cycle could not be completed." }, { status: 500 });
  }
}
