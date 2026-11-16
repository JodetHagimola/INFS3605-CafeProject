import "server-only";

import { inventoryClient } from "@/lib/inventory/server";

type ActivityOutcome = "started" | "success" | "blocked" | "error";

function summarizeInput(input: unknown): string {
  const summary = JSON.stringify(input);
  return (summary ?? "No input").slice(0, 1000);
}

function summarizeResult(result: unknown): { outcome: ActivityOutcome; reason: string } {
  if (typeof result === "object" && result !== null && !Array.isArray(result)) {
    const data = result as Record<string, unknown>;
    const flags = Array.isArray(data.flags) ? data.flags.filter((flag): flag is string => typeof flag === "string") : [];
    if (data.status === "blocked" || data.status === "insufficient_history" || data.sufficientHistory === false) {
      return {
        outcome: "blocked",
        reason: flags.join(" ").slice(0, 1000)
          || (Array.isArray(data.limitations)
            ? data.limitations.filter((item): item is string => typeof item === "string").join(" ").slice(0, 1000)
            : `Tool returned ${String(data.status ?? "insufficient data")}.`),
      };
    }
    if (typeof data.status === "string") {
      return { outcome: "success", reason: `Tool returned ${data.status}. ${flags.join(" ")}`.slice(0, 1000) };
    }
  }
  if (Array.isArray(result)) return { outcome: "success", reason: `Returned ${result.length} records.` };
  return { outcome: "success", reason: "Completed with a structured result." };
}

async function updateActivity(
  id: number,
  outcome: ActivityOutcome,
  reason: string,
): Promise<void> {
  const { error } = await inventoryClient()
    .from("agent_activity")
    .update({ outcome, reason: reason.slice(0, 1000) })
    .eq("id", id);
  if (error) {
    console.error("Could not update agent activity:", error.message);
    throw new Error("The agent activity result could not be recorded.");
  }
}

export async function withAgentActivity<T>(
  toolName: string,
  input: unknown,
  execute: (activityId: number) => Promise<T>,
  options: { trigger?: string; taskId?: string } = {},
): Promise<T> {
  const { data, error } = await inventoryClient()
    .from("agent_activity")
    .insert({
      tool: toolName,
      input_summary: summarizeInput(input),
      outcome: "started",
      reason: "Tool call started.",
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(options.taskId ? { task_id: options.taskId } : {}),
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("Could not start agent activity record:", error?.message ?? "No row returned");
    throw new Error("The agent activity log is unavailable; no tool action was run.");
  }

  let result: T;
  try {
    result = await execute(data.id);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The tool failed.";
    await updateActivity(data.id, "error", reason);
    throw error;
  }

  const summary = summarizeResult(result);
  await updateActivity(data.id, summary.outcome, summary.reason);
  return result;
}
