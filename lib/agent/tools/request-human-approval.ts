import { tool } from "ai";
import { z } from "zod";
import {
  approvalActionSchema,
  approvalRequestDetailsSchema,
} from "@/lib/agent/approval-schema";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";

export function createRequestHumanApprovalTool(onCreated?: (approvalId: string, autoApproved: boolean) => void) {
  return tool({
    description: "For a proposed purchase, supplier contact/switch, or price change, create a pending human approval item. Legacy standing_rules are inactive; only the café reorder policy governs the separate test-mode ordering cycle. This tool never sends an order or contacts a supplier.",
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
        const { data: existingApproval, error: existingApprovalError } = await inventoryClient()
          .from("approval_inbox")
          .select("id,status")
          .contains("details", { draftId: input.draftId })
          .in("status", ["pending_approval", "approved"])
          .limit(1)
          .maybeSingle();
        if (existingApprovalError) {
          console.error("Could not check for an existing draft approval:", existingApprovalError.message);
          throw new Error("Existing approval requests for this draft could not be checked.");
        }
        if (existingApproval) {
          return {
            status: "blocked" as const,
            flags: ["This draft already has a pending or approved request. Review its existing approval record instead."],
            approval: null,
          };
        }
        const { data, error } = await inventoryClient()
          .from("draft_orders")
          .select("id,status")
          .eq("id", input.draftId)
          .maybeSingle();
        if (error || !data) {
          console.error("Could not verify a draft for approval:", error?.message ?? "No draft found");
          throw new Error("The draft could not be verified.");
        }
        if (data.status !== "draft") {
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

      const approvalId = String(data.id);
      onCreated?.(approvalId, false);
      return {
        status: "pending_approval" as const,
        approval: {
          id: approvalId,
          action: data.action,
          summary: data.summary,
          details: data.details,
        },
        flags: ["This request is pending human review. No order was placed, no supplier was contacted, and no price was changed."],
      };
    }),
  });
}

export const requestHumanApprovalTool = createRequestHumanApprovalTool();
