import { tool } from "ai";
import { z } from "zod";
import { isValidISODate } from "@/lib/agent/date";
import { getRecordedOperations } from "@/lib/inventory-sales/operations";
import { sydneyDay } from "@/lib/inventory-sales/operations-model";
import { withAgentActivity } from "./activity";

export const recordedOperationsTool = tool({
  description: "Read actual manual sales, saved recipe consumption and confirmed receipts for one Sydney calendar day (defaults to today). Use this to explain today's recorded ingredient usage and receipts. These are partial observed entries, not forecast demand, total footfall, or a complete explanation of all stock changes. Never add them to historical forecast data or change inventory again.",
  inputSchema: z.object({ date: z.string().refine(isValidISODate).optional() }).strict(),
  execute: async (input) => withAgentActivity("get_recorded_operations", input, () =>
    getRecordedOperations(input.date ?? sydneyDay(new Date().toISOString()))),
});
