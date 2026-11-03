import { tool } from "ai";
import { z } from "zod";
import { getInventory } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";

export const getInventoryTool = tool({
  description: "Read current ingredient stock, minimum levels, units, and update times from the shared inventory table.",
  inputSchema: z.object({}).strict(),
  execute: async (input) => withAgentActivity("get_inventory", input, async () => {
    const result = await getInventory();
    if (result.error) throw new Error(result.error);
    return result.items;
  }),
});
