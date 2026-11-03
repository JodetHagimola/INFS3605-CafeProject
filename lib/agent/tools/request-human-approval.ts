import { tool } from "ai";
import { z } from "zod";
import {
  approvalActionSchema,
  approvalRequestDetailsSchema,
} from "@/lib/agent/approval-schema";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";

export const requestHumanApprovalTool = tool({
  description: "For any proposed purchase, supplier contact/switch, or price change, create a pending_approval inbox item only. This tool cannot execute, approve, or send an action.",
  inputSchema: z.object({
    action: approvalActionSchema,
    summary: z.string().trim().min(1).max(500),
    details: approvalRequestDetailsSchema,
    draftId: z.string().uuid().optional(),
  }).strict(),
  execute: async (input) => withAgentActivity("request_human_approval", input, async () => {
    if (input.action === "place_or_send_order") {
      if (!input.draftId) {
        return {
          status: "blocked" as const,
          flags: ["A saved draft ID is required before requesting approval to place or send an order."],
          approval: null,
        };
      }
      const { data, error } = await inventoryClient()
        .from("draft_orders")
        .select("id,status")
        .eq("id", input.draftId)
        .maybeSingle();
      if (error) {
        console.error("Could not verify a draft for approval:", error.message);
        throw new Error("The draft could not be verified.");
      }
      if (!data || data.status !== "draft") {
        return {
          status: "blocked" as const,
          flags: ["Only a saved draft can be submitted to the approval inbox."],
          approval: null,
        };
      }
    }

    const details = {
      ...input.details,
      ...(input.draftId ? { draftId: input.draftId } : {}),
      agentGenerated: true,
    };
    const { data, error } = await inventoryClient()
      .from("approval_inbox")
      .insert({
        action: input.action,
        summary: input.summary,
        details,
        status: "pending_approval",
      })
      .select("id,action,summary,details,status,created_at,reviewed_at,reviewer_note")
      .single();
    if (error || !data) {
      console.error("Could not save an approval inbox item:", error?.message ?? "No row returned");
      throw new Error("The approval request could not be saved.");
    }

    return {
      status: "pending_approval" as const,
      approval: {
        id: String(data.id),
        action: data.action,
        summary: data.summary,
        details: data.details,
      },
      flags: ["This request is pending human review. No order was placed, no supplier was contacted, and no price was changed."],
    };
  }),
});
