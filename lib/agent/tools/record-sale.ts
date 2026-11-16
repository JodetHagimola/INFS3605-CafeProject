import { createHash } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { getSaleProducts, persistSale } from "@/lib/inventory-sales/server";
import { withAgentActivity } from "./activity";

function saleRequestId(requestKey: string, product: string): string {
  const bytes = createHash("sha256").update(`${requestKey}\0${product}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createRecordSaleTool(requestKey: string) {
  return tool({
  description: "Record a completed sale explicitly reported by the owner. Use an exact recipe product name and a whole quantity from 1 to 1000. If the product is ambiguous or not an available recipe, do not guess; return the available names so the owner can clarify.",
  inputSchema: z.object({
    product_name: z.string().trim().min(1).max(120),
    quantity: z.number().int().min(1).max(1000),
  }).strict(),
  execute: async (input) => withAgentActivity("record_sale", input, async () => {
    const recipes = await getSaleProducts();
    if (recipes.error) throw new Error(recipes.error);
    const product = recipes.products.find((candidate) =>
      candidate.name.toLocaleLowerCase() === input.product_name.toLocaleLowerCase());
    if (!product) {
      return {
        status: "needs_clarification",
        message: "That name does not exactly match one available recipe. Ask the owner to choose a listed drink.",
        available_products: recipes.products.map((item) => item.name),
      };
    }

    const result = await persistSale({
      id: saleRequestId(requestKey, product.name),
      product: product.name,
      quantity: input.quantity,
    }, "chat");
    if (result.status !== "success" || !result.receipt) throw new Error(result.message);
    return {
      status: "recorded",
      sale_id: result.receipt.sale_id,
      product_name: result.receipt.product_name,
      quantity: result.receipt.quantity,
      replayed: result.receipt.replayed,
      message: result.message,
    };
  }, { trigger: "owner_chat" }),
  });
}
