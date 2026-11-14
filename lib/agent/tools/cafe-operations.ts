import { tool } from "ai";
import { z } from "zod";
import { inventoryClient } from "@/lib/inventory/server";
import { listSupplierDrafts } from "@/lib/inventory-deliveries/followups";
import { withAgentActivity } from "./activity";

export const drinkCapacityTool = tool({
  description: "Check how many whole servings of one exact menu product can be made with the current stock and recipe. Return the limiting ingredients. This assumes stock is used only for this product.",
  inputSchema: z.object({ product: z.string().trim().min(1).max(120) }).strict(),
  execute: ({ product }) => withAgentActivity("get_drink_capacity", { product }, async () => {
    const { data, error } = await inventoryClient().rpc("drink_capacity", { p_product: product });
    if (error || !data) throw new Error("Drink capacity could not be calculated.");
    return data;
  }),
});

export const supplierDraftsTool = tool({
  description: "Read the latest 20 saved supplier email drafts for confirmed final short deliveries, for the owner to review. Partial arrivals expecting more goods do not produce drafts.",
  inputSchema: z.object({}).strict(),
  execute: () => withAgentActivity("get_supplier_drafts", {}, listSupplierDrafts),
});
