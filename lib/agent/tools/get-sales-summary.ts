import { tool } from "ai";
import { z } from "zod";
import { buildSalesSummary, salesRowsFromDatabase } from "./sales-summary-model";
import { withAgentActivity } from "./activity";
import { readAll } from "./shared";

export async function loadSalesSummary() {
  const rows = await readAll(
    "sales_history",
    "sales_date,product_name,units_sold,is_public_holiday,source",
  );
  const today = new Date().toISOString().slice(0, 10);
  const history = salesRowsFromDatabase(rows).filter((row) => row.salesDate <= today);
  return buildSalesSummary(history);
}

export function createGetSalesSummaryTool(onRead: () => void) {
  return tool({
    description: "Read historical sales and return code-computed product, weekday, month, recent-trend, and public-holiday aggregates.",
    inputSchema: z.object({}).strict(),
    execute: async (input) => {
      const summary = await withAgentActivity("get_sales_summary", input, loadSalesSummary);
      onRead();
      return summary;
    },
  });
}
