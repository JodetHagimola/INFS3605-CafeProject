import "server-only";

import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";

const activitySchema = z.object({
  id: z.number().int().positive(),
  created_at: z.string().min(1),
  tool: z.string(),
  input_summary: z.string(),
  outcome: z.enum(["started", "success", "blocked", "error"]),
  reason: z.string(),
});

export type AgentActivity = {
  id: number;
  timestamp: string;
  tool: string;
  inputSummary: string;
  outcome: "started" | "success" | "blocked" | "error";
  reason: string;
};

export async function getAgentActivity(): Promise<AgentActivity[]> {
  const { data, error } = await inventoryClient()
    .from("agent_activity")
    .select("id,created_at,tool,input_summary,outcome,reason")
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    console.error("Could not read agent activity:", error.message);
    throw new Error("Agent activity could not be loaded. Check the Supabase setup.");
  }
  return (data ?? []).map((row) => {
    const parsed = activitySchema.safeParse(row);
    if (!parsed.success) throw new Error("An agent activity record is invalid.");
    return {
      id: parsed.data.id,
      timestamp: parsed.data.created_at,
      tool: parsed.data.tool,
      inputSummary: parsed.data.input_summary,
      outcome: parsed.data.outcome,
      reason: parsed.data.reason,
    };
  });
}
