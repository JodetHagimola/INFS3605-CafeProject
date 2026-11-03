import { tool } from "ai";
import { z } from "zod";
import {
  approvalActionSchema,
  approvalRequestDetailsSchema,
} from "@/lib/agent/approval-schema";
import { draftOrderSchema } from "@/lib/agent/draft-schema";
import { inventoryClient } from "@/lib/inventory/server";
import { withAgentActivity } from "./activity";

async function matchingStandingRule(draftId: string): Promise<{ id: string; name: string } | null> {
  const db = inventoryClient();
  const { data: draftRow, error: draftError } = await db
    .from("draft_orders")
    .select("id,status,forecast_date,created_at,forecast,lines,flags,data_used")
    .eq("id", draftId)
    .maybeSingle();
  if (draftError || !draftRow) {
    console.error("Could not load a draft for standing-rule evaluation:", draftError?.message ?? "No draft found");
    throw new Error("The draft could not be verified against standing rules.");
  }
  const draft = draftOrderSchema.parse({
    id: String(draftRow.id),
    status: draftRow.status,
    forecastDate: draftRow.forecast_date,
    createdAt: draftRow.created_at,
    forecast: draftRow.forecast,
    lines: draftRow.lines,
    flags: draftRow.flags,
    dataUsed: draftRow.data_used,
  });
  if (draft.status !== "draft" || draft.lines.length === 0) return null;

  const { data: rules, error: rulesError } = await db
    .from("standing_rules")
    .select("id,name,ingredient_ids,supplier,maximum_total")
    .eq("enabled", true);
  if (rulesError) {
    console.error("Could not read standing rules:", rulesError.message);
    throw new Error("Standing rules could not be checked; human review is required.");
  }

  const total = Math.round(draft.lines.reduce(
    (sum, line) => sum + line.recommendedOrderQuantity * line.recommendedSupplier.price,
    0,
  ) * 100) / 100;
  if (!Number.isFinite(total) || total <= 0) return null;

  const lineIngredients = new Set(draft.lines.map((line) => line.ingredientId));
  const supplier = draft.lines[0]?.recommendedSupplier.supplier;
  if (!supplier || draft.lines.some((line) => line.recommendedSupplier.supplier !== supplier)) return null;

  const match = (rules ?? []).find((rule) => {
    const allowedIngredients = new Set((rule.ingredient_ids ?? []).map(String));
    return rule.supplier === supplier
      && lineIngredients.size > 0
      && [...lineIngredients].every((id) => allowedIngredients.has(id))
      && typeof rule.maximum_total === "number"
      && total <= rule.maximum_total;
  });
  return match ? { id: String(match.id), name: String(match.name) } : null;
}

export function createRequestHumanApprovalTool(onCreated?: (approvalId: string, autoApproved: boolean) => void) {
  return tool({
    description: "For a proposed purchase, supplier contact/switch, or price change, create an approval item only. A saved draft order may be marked approved only when it exactly matches an enabled standing rule for all ingredients, the same supplier, and the total cap. This tool never sends an order or contacts a supplier.",
    inputSchema: z.object({
      action: approvalActionSchema,
      summary: z.string().trim().min(1).max(500),
      details: approvalRequestDetailsSchema,
      draftId: z.string().uuid().optional(),
    }).strict(),
    execute: async (input) => withAgentActivity("request_human_approval", input, async () => {
      let matchedRule: { id: string; name: string } | null = null;
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
        matchedRule = await matchingStandingRule(input.draftId);
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
        ...(matchedRule ? { standingRuleId: matchedRule.id, standingRuleName: matchedRule.name } : {}),
      };
      const autoApproved = matchedRule !== null;
      const { data, error } = await inventoryClient()
        .from("approval_inbox")
        .insert({
          action: input.action,
          summary: input.summary,
          details,
          status: autoApproved ? "approved" : "pending_approval",
          ...(autoApproved ? {
            reviewed_at: new Date().toISOString(),
            reviewer_note: `Approved by standing rule "${matchedRule?.name ?? "unknown"}". No order was placed or sent.`,
          } : {}),
        })
        .select("id,action,summary,details,status,created_at,reviewed_at,reviewer_note")
        .single();
      if (error || !data) {
        console.error("Could not save an approval inbox item:", error?.message ?? "No row returned");
        throw new Error("The approval request could not be saved.");
      }

      const approvalId = String(data.id);
      onCreated?.(approvalId, autoApproved);
      return {
        status: autoApproved ? "approved" as const : "pending_approval" as const,
        approval: {
          id: approvalId,
          action: data.action,
          summary: data.summary,
          details: data.details,
        },
        flags: [autoApproved
          ? `Approved by standing rule "${matchedRule?.name ?? "unknown"}". No order was placed, no supplier was contacted, and no price was changed.`
          : "This request is pending human review. No order was placed, no supplier was contacted, and no price was changed."],
      };
    }),
  });
}

export const requestHumanApprovalTool = createRequestHumanApprovalTool();
