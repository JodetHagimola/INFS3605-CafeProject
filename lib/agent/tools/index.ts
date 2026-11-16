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
import { drinkCapacityTool, supplierDraftsTool } from "./cafe-operations";
import { recordedOperationsTool } from "./recorded-operations";
import { createRecordSaleTool } from "./record-sale";

export function createAgentTools(defaults: {
  forecastDate: string;
  isPublicHoliday: boolean | null;
}, options: {
  onApprovalCreated?: (approvalId: string, autoApproved: boolean) => void;
  profile?: "full" | "daily-brief";
  saleRequestId?: string;
} = {}) {
  let forecast: DemandForecast | null = null;
  let draft: DraftOrderRecord | null = null;
  let salesSummaryRead = false;
  const saveDraftOrderTool = createSaveDraftOrderTool(() => forecast, (result) => {
    draft = result;
  }, () => draft !== null);
  const tools = {
    get_inventory: getInventoryTool,
    get_drink_capacity: drinkCapacityTool,
    get_supplier_drafts: supplierDraftsTool,
    get_recorded_operations: recordedOperationsTool,
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
    save_draft_order: saveDraftOrderTool,
    ...(options.profile === "daily-brief" ? {} : {
      ...(options.saleRequestId ? { record_sale: createRecordSaleTool(options.saleRequestId) } : {}),
      request_human_approval: createRequestHumanApprovalTool(options.onApprovalCreated),
      log_wastage: logWastageTool,
      record_delivery: recordDeliveryTool,
    }),
  };
  return {
    tools,
    getDraft: () => draft,
  };
}
