import "server-only";

import { randomUUID } from "node:crypto";
import { inventoryClient } from "@/lib/inventory/server";

export async function trackAutomationCycle<T>(
  cycle: "orders" | "deliveries" | "thresholds",
  run: () => Promise<T>,
): Promise<T> {
  const db = inventoryClient();
  const id = randomUUID();
  const started = await db.from("automation_cycle_runs").insert({
    id,
    cycle,
    status: "running",
  });
  if (started.error) throw new Error(`Could not record the ${cycle} cycle start: ${started.error.message}`);

  try {
    const result = await run();
    const finished = await db.from("automation_cycle_runs")
      .update({ status: "completed", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running");
    if (finished.error) throw new Error(`Could not record the ${cycle} cycle result: ${finished.error.message}`);
    return result;
  } catch (error) {
    const failed = await db.from("automation_cycle_runs")
      .update({ status: "failed", finished_at: new Date().toISOString() })
      .eq("id", id)
      .eq("status", "running");
    if (failed.error) console.error(`Could not record the failed ${cycle} cycle:`, failed.error.message);
    throw error;
  }
}
