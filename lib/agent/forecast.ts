import forecastTable from "../../ML/agent_forecast_table.json" with { type: "json" };

const PRODUCTS = ["Latte", "Cappuccino", "Flat White", "Long Black", "Mocha"] as const;

export function forecastDrinkSales(forecastDate: string, isPublicHoliday: boolean) {
  const parsedDate = new Date(`${forecastDate}T00:00:00.000Z`);
  if (!Number.isFinite(parsedDate.getTime())
    || parsedDate.toISOString().slice(0, 10) !== forecastDate) {
    throw new Error("Choose a valid forecast date.");
  }

  const dayNumber = (parsedDate.getUTCDay() + 6) % 7;
  const key = `${parsedDate.getUTCMonth() + 1}-${dayNumber}-${Number(isPublicHoliday)}`;
  const row = forecastTable[key as keyof typeof forecastTable];
  if (!row) {
    throw new Error("The saved forecast model does not include this date.");
  }

  const predictedSales: Record<string, number> = {};
  for (const product of PRODUCTS) {
    const sales = row[product];
    if (!Number.isSafeInteger(sales) || sales < 0) {
      throw new Error(`The saved forecast for ${product} is invalid.`);
    }
    predictedSales[product] = sales;
  }

  return {
    forecastDate,
    isPublicHoliday,
    predictedSales,
    source: "Saved model trained on synthetic sales data",
  };
}
