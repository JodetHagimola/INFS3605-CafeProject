import { createCalculateShortfallsTool } from "./calculate-shortfalls";
import { checkDeliveriesTool } from "./check-deliveries";
import { compareSupplierPricesTool } from "./compare-supplier-prices";
import { createForecastDemandTool } from "./forecast-demand";
import type { DemandForecast } from "./forecast-model";
import { getInventoryTool } from "./get-inventory";
import { getRecipesTool } from "./get-recipes";
import { createGetSalesSummaryTool } from "./get-sales-summary";
import { createSaveDraftOrderTool } from "./save-draft-order";
import type { DraftOrderRecord } from "@/lib/agent/draft-schema";
import { createRequestHumanApprovalTool } from "./request-human-approval";
import { logWastageTool } from "./log-wastage";
import { recordDeliveryTool } from "./record-delivery";

export function createAgentTools(defaults: {
  forecastDate: string;
  isPublicHoliday: boolean | null;
}, options: { onApprovalCreated?: (approvalId: string, autoApproved: boolean) => void } = {}) {
  let forecast: DemandForecast | null = null;
  let draft: DraftOrderRecord | null = null;
  let salesSummaryRead = false;
  return {
    tools: {
      get_inventory: getInventoryTool,
      get_recipes: getRecipesTool,
      get_sales_summary: createGetSalesSummaryTool(() => {
        salesSummaryRead = true;
      }),
      forecast_demand: createForecastDemandTool(defaults, () => salesSummaryRead, (result) => {
        forecast = result;
      }),
      calculate_shortfalls: createCalculateShortfallsTool(() => forecast),
      compare_supplier_prices: compareSupplierPricesTool,
      check_deliveries: checkDeliveriesTool,
      save_draft_order: createSaveDraftOrderTool(() => forecast, (result) => {
        draft = result;
      }, () => draft !== null),
      request_human_approval: createRequestHumanApprovalTool(options.onApprovalCreated),
      log_wastage: logWastageTool,
      record_delivery: recordDeliveryTool,
    },
    getDraft: () => draft,
  };
}
