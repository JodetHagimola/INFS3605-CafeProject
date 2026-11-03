import "server-only";

import { generateText, isStepCount, Output } from "ai";
import { inventoryClient } from "@/lib/inventory/server";
import { createAgentTools } from "./tools";
import { dailyBriefSchema, type DailyBrief } from "./brief-schema";
import { getGeminiModel, geminiModelRejectionMessage } from "./model";

const BRIEF_INSTRUCTIONS = `You are Brewlytics, a proactive morning assistant for a small café owner.

Use the available tools to inspect stock, recipes, sales history, deliveries, shortfalls, and suppliers. Work through the data in a few purposeful steps; stop after at most ten total steps. Let TypeScript tools do all arithmetic.

Boundaries:
- Never place or send orders, contact suppliers, or change a price.
- Saving a draft and creating a pending human approval are allowed. A saved draft may be marked approved only by an exact enabled standing rule; tell the owner when this happens. No external action is taken.
- Never invent stock, sales, prices, suppliers, dates, deliveries, or actions. If a data source is missing, include a plain-English warning and continue with the available data.
- Forecasts are indicative AI estimates from sales history, possibly synthetic. Do not forecast when a tool reports insufficient history.
- Do not recommend negative quantities. Stop and flag any order above twice forecast requirements.

Return a concise structured morning brief. Include at most three items, ranked by urgency; use no item if nothing needs the owner's attention. Each item must have one primary action and may have one secondary action. Mention actions already taken, such as a saved draft, accurately. The details are for an expander, not the front screen.`;

const BRIEF_SELECT = "brief_date,greeting,status_line,items,all_clear,details";

function briefErrorDetails(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const providerError = error as Error & {
    statusCode?: unknown;
    isRetryable?: unknown;
    url?: unknown;
  };
  const message = error.message
    .replace(/AIza[0-9A-Za-z_-]{20,}/g, "[redacted]")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[redacted]");
  return JSON.stringify({
    name: error.name,
    message: message.slice(0, 1200),
    statusCode: typeof providerError.statusCode === "number" ? providerError.statusCode : undefined,
    retryable: typeof providerError.isRetryable === "boolean" ? providerError.isRetryable : undefined,
    provider: typeof providerError.url === "string"
      ? (() => {
        try {
          return new URL(providerError.url).hostname;
        } catch {
          return undefined;
        }
      })()
      : undefined,
  });
}

export function cafeLocalDate(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function mapStoredBrief(row: Record<string, unknown>): DailyBrief {
  return dailyBriefSchema.parse({
    greeting: row.greeting,
    statusLine: row.status_line,
    items: row.items,
    allClear: row.all_clear,
    details: row.details,
  });
}

async function loadCachedBrief(date: string): Promise<DailyBrief | null> {
  let data;
  let error;
  try {
    ({ data, error } = await inventoryClient()
      .from("daily_briefs")
      .select(BRIEF_SELECT)
      .eq("brief_date", date)
      .maybeSingle());
  } catch (loadError) {
    console.error("Could not connect to the daily brief store:", loadError instanceof Error ? loadError.message : "Unknown error");
    throw new Error("Today's brief could not be loaded. Check the daily brief setup.");
  }
  if (error) {
    console.error("Could not read the cached daily brief:", error.message);
    throw new Error("Today's brief could not be loaded. Check the daily brief setup.");
  }
  if (!data) return null;
  try {
    return mapStoredBrief(data as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("The cached daily brief failed validation:", error instanceof Error ? error.name : "Unknown error");
    throw new Error("Today's saved brief has invalid data and could not be shown.");
  }
}

export async function readPublicHoliday(date: string): Promise<{ name: string | null; error: boolean }> {
  let data;
  let error;
  try {
    ({ data, error } = await inventoryClient()
      .from("public_holidays")
      .select("name")
      .eq("jurisdiction", "NSW")
      .eq("holiday_date", date)
      .maybeSingle());
  } catch (holidayError) {
    console.error("Could not check the NSW public holiday calendar:", holidayError instanceof Error ? holidayError.message : "Unknown error");
    return { name: null, error: true };
  }
  if (error) {
    console.error("Could not check the NSW public holiday calendar:", error.message);
    return { name: null, error: true };
  }
  return { name: data?.name ?? null, error: false };
}

async function generateDailyBrief(date: string): Promise<DailyBrief> {
  const holiday = await readPublicHoliday(date);
  const createdApprovalIds = new Set<string>();
  const autoApprovedIds = new Set<string>();
  const tools = createAgentTools({
    forecastDate: date,
    isPublicHoliday: holiday.error ? null : holiday.name !== null,
  }, { onApprovalCreated: (approvalId, autoApproved) => {
    createdApprovalIds.add(approvalId);
    if (autoApproved) autoApprovedIds.add(approvalId);
  } });

  let generated: DailyBrief;
  try {
    const result = await generateText({
      model: getGeminiModel(),
      output: Output.object({ schema: dailyBriefSchema }),
      instructions: BRIEF_INSTRUCTIONS,
      prompt: [
        `Prepare the café's brief for ${date} (Australia/Sydney).`,
        holiday.error
          ? "The NSW public holiday lookup failed. Do not infer holiday status; include a warning."
          : holiday.name
            ? `The NSW calendar lists ${holiday.name} today.`
            : "The NSW calendar has no listed public holiday for today.",
        "Use get_inventory, get_recipes, get_sales_summary, forecast_demand, calculate_shortfalls, check_deliveries, and compare_supplier_prices as appropriate.",
        "For demand, forecast the next three dates when history permits. Forecast every product from the returned sales summary.",
        "Only save a draft or create an approval item when supported by the tool data. A standing rule can record approval only for a matching saved draft; no external action may be taken.",
        "For every displayed item, ensure its primary action points to an existing approval only when you have its exact approval ID. Otherwise choose Edit, Confirm, or Dismiss without inventing an ID.",
      ].join("\n\n"),
      tools: tools.tools,
      stopWhen: isStepCount(10),
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(45_000),
    });

    if (!result.output) throw new Error("The model returned no structured brief.");
    generated = dailyBriefSchema.parse(result.output);
  } catch (error) {
    const rejectedModel = geminiModelRejectionMessage(error);
    if (rejectedModel) throw new Error(rejectedModel);
    if (error instanceof Error && error.message === "The Gemini API key is not configured on the server.") {
      throw error;
    }
    console.error("Could not generate today's brief:", briefErrorDetails(error));
    throw new Error("Today's brief could not be generated. Check the café data and try again.");
  }

  generated.items = generated.items.map((item) => {
    const validateAction = (action: DailyBrief["items"][number]["primaryAction"]) => {
      if (action.approvalId && autoApprovedIds.has(action.approvalId)) {
        return { label: "Confirm" as const, approvalId: action.approvalId };
      }
      if ((action.label === "Approve" || action.label === "Dismiss")
        && (!action.approvalId || !createdApprovalIds.has(action.approvalId))) {
        return { label: "Edit" as const };
      }
      return action;
    };
    return {
      ...item,
      primaryAction: validateAction(item.primaryAction),
      ...(item.secondaryAction ? { secondaryAction: validateAction(item.secondaryAction) } : {}),
    };
  });

  if (holiday.error && !generated.details.dataWarnings.some((warning) => /holiday/i.test(warning))) {
    generated.details.dataWarnings.push("I couldn't check today's NSW public holiday calendar.");
  }
  return dailyBriefSchema.parse(generated);
}

export async function getDailyBrief(options: { refresh?: boolean; date?: string } = {}): Promise<DailyBrief & { briefDate: string }> {
  const date = options.date ?? cafeLocalDate();
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00.000Z`) : null;
  if (!parsedDate || parsedDate.toISOString().slice(0, 10) !== date) {
    throw new Error("The requested brief date is invalid.");
  }
  if (!options.refresh) {
    const cached = await loadCachedBrief(date);
    if (cached) return { ...cached, briefDate: date };
  }

  const brief = await generateDailyBrief(date);
  let error;
  try {
    ({ error } = await inventoryClient()
      .from("daily_briefs")
      .upsert({
        brief_date: date,
        greeting: brief.greeting,
        status_line: brief.statusLine,
        items: brief.items,
        all_clear: brief.allClear,
        details: brief.details,
        generated_at: new Date().toISOString(),
      }, { onConflict: "brief_date" }));
  } catch (saveError) {
    console.error("Could not cache today's brief:", saveError instanceof Error ? saveError.message : "Unknown error");
    throw new Error("Today's brief was created but could not be saved.");
  }
  if (error) {
    console.error("Could not cache today's brief:", error.message);
    throw new Error("Today's brief was created but could not be saved.");
  }
  return { ...brief, briefDate: date };
}
