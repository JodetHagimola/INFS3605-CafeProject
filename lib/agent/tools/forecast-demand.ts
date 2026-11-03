import { tool } from "ai";
import { z } from "zod";
import { validateAgentForecast, type AgentForecastProposal, type DemandForecast } from "./forecast-model";
import { loadSalesSummary } from "./get-sales-summary";
import { validDate } from "./shared";
import { withAgentActivity } from "./activity";

const forecastInput = z.object({
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dailyForecasts: z.array(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    products: z.record(z.string().min(1).max(120), z.object({
      low: z.number().int().nonnegative(),
      expected: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
    }).strict()),
  }).strict()).min(1).max(31),
  assumptions: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
}).strict();

export function createForecastDemandTool(defaults: {
  forecastDate: string;
  isPublicHoliday: boolean | null;
}, hasReadSalesSummary: () => boolean, onForecast: (forecast: DemandForecast) => void) {
  return tool({
    description: "After get_sales_summary, use its historical aggregates to produce Gemini's whole-number low/expected/high sales estimates, one entry per date and product, plus assumptions. This tool validates the estimates and blocks insufficient history.",
    inputSchema: forecastInput,
    execute: async (input) => withAgentActivity("forecast_demand", input, async () => {
      const startDate = validDate(input.startDate ?? defaults.forecastDate, "Forecast start date");
      const endDate = input.endDate ? validDate(input.endDate, "Forecast end date") : undefined;
      const summary = await loadSalesSummary();
      const proposal: AgentForecastProposal = {
        startDate,
        endDate,
        isPublicHoliday: defaults.isPublicHoliday,
        dailyForecasts: input.dailyForecasts,
        assumptions: input.assumptions,
      };
      const forecast = hasReadSalesSummary()
        ? validateAgentForecast(summary, proposal)
        : {
          startDate,
          endDate: endDate ?? startDate,
          status: "insufficient_history" as const,
          source: `Gemini AI estimate based on available sales history (${summary.source}).`,
          assumptions: input.assumptions,
          flags: ["Read get_sales_summary before requesting a forecast; no prediction was accepted."],
          dailyForecasts: [],
          totals: {},
        };
      onForecast(forecast);
      return forecast;
    }),
  });
}
