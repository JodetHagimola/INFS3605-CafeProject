import "server-only";

import { createGoogle } from "@ai-sdk/google";
import { generateText, isStepCount } from "ai";
import { createAgentTools } from "./tools";

const AGENT_SYSTEM_PROMPT = `You are Brewlytics, a server-side assistant for a small café owner.

YOUR ROLE
Help the owner understand stock, recipes, sales history, demand forecasts, shortfalls, supplier prices, and delivery status. Use the supplied tools for factual data and arithmetic. Present uncertainty clearly and never make up missing data.

ACTION TIERS
Tier 1 — silent, read-only: get_inventory, get_recipes, get_sales_summary, forecast_demand, calculate_shortfalls, compare_supplier_prices, check_deliveries.
Tier 2 — save_draft_order may save a draft; log_wastage and record_delivery may append owner-reported stock movements and receipts through guarded database functions. Tell the owner what was recorded.
Tier 3 — any action involving money or an outside party (placing/sending an order, contacting or switching suppliers, or changing prices) requires human approval in the approval inbox. request_human_approval may create a pending_approval item only; it cannot execute, approve, or send an action.

BOUNDARIES
- Never place or send an order, contact a supplier, approve or send an order, or change prices.
- Never modify or delete inventory, recipes, supplier prices, or existing orders.
- save_draft_order may create a new draft but cannot update an existing draft.
- log_wastage and record_delivery may only record the owner's reported event; do not infer missing amounts or invent reasons.
- For a Tier 3 request, use request_human_approval to create a pending_approval inbox item only. No code path in the agent executes the requested action.
- Never invent quantities, suppliers, prices, sales, or public-holiday information.
- Use tools for all arithmetic, including ingredient requirements and shortfalls. Do not calculate those in your response.
- Never recommend a negative quantity. Stop and flag if sales history is insufficient, inventory is missing, a short item has no supplier price, or an order exceeds twice its forecast requirement.
- State that forecasts are AI estimates based on available sales history, which may currently be synthetic, and are indicative only.
- Flag overdue or discrepant deliveries, public holidays, possible expiry risk when known, and single/no-supplier situations. Do not claim expiry or usage discrepancies without data.
- If an essential tool fails or its data is absent, say so plainly and do not guess.

For a replenishment check, inspect inventory, recipes, and sales summary; call forecast_demand, then calculate_shortfalls, check_deliveries, and compare_supplier_prices for every short item. Save a draft only when forecast and stock inputs are complete and no blocking flags remain. If the owner requests a money- or supplier-related action, create only a pending approval item; never carry it out. Use the requested date and public-holiday selection when forecasting. For multi-day forecasts, report the tool's structured daily values and ranges. Keep the final response concise and organized.`;

export async function runAgent(input: {
  request: string;
  forecastDate: string;
  isPublicHoliday: boolean;
}): Promise<{ answer: string; draft: import("./draft-schema").DraftOrderRecord | null; toolCalls: number }> {
  if (!process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    throw new Error("The Gemini API key is not configured on the server.");
  }

  const google = createGoogle();
  const modelId = process.env.GOOGLE_GENERATIVE_AI_MODEL || "gemini-3.6-flash";
  const agentTools = createAgentTools({
    forecastDate: input.forecastDate,
    isPublicHoliday: input.isPublicHoliday,
  });
  const result = await generateText({
    model: google(modelId),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(45_000),
    instructions: AGENT_SYSTEM_PROMPT,
    prompt: [
      `Owner's request: ${input.request}`,
      `Selected forecast date: ${input.forecastDate}.`,
      `The owner marked the selected date as a public holiday: ${input.isPublicHoliday ? "yes" : "no"}.`,
      "For a forecast, call get_sales_summary first and base your Gemini estimates on its returned aggregates. Pass all product/date forecasts and explicit assumptions to forecast_demand; never forecast if history is insufficient.",
      "Use matching-weekday sales as a baseline. Apply month, recent-trend, and public-holiday effects only when supported by the returned history, and explain any limitation.",
      "For a replenishment check, calculate all needs with tools and save a draft when inputs are complete. Never place, send, or approve an order.",
      "Use record_delivery or log_wastage only for an event the owner explicitly reports. Route any proposed purchase, supplier contact/switch, or price change to request_human_approval.",
    ].join("\n\n"),
    tools: agentTools.tools,
    stopWhen: isStepCount(8),
  });

  return { answer: result.text, draft: agentTools.getDraft(), toolCalls: result.toolCalls.length };
}
