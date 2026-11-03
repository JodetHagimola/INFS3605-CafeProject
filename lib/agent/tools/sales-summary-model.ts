export type SalesRecord = {
  salesDate: string;
  productName: string;
  unitsSold: number;
  isPublicHoliday: boolean;
  source?: "synthetic_demo" | "imported";
};

export type SalesBucket = {
  days: number;
  units: number;
  averageUnits: number;
};

export type ProductSalesSummary = {
  daysWithSalesData: number;
  totalUnits: number;
  averageUnitsPerDay: number;
  byWeekday: Record<string, SalesBucket>;
  byMonth: Record<string, SalesBucket>;
  recentTrendPercent: number | null;
  publicHoliday: {
    holidayDays: number;
    holidayAverage: number | null;
    ordinaryDays: number;
    ordinaryAverage: number | null;
  };
};

export type SalesSummary = {
  source: string;
  observedFrom: string | null;
  observedThrough: string | null;
  calendarDaysCovered: number;
  recordCount: number;
  sufficientHistory: boolean;
  limitations: string[];
  products: Record<string, ProductSalesSummary>;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function utcDay(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function daysBetween(start: string, end: string): number {
  return Math.floor((Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000) + 1;
}

function bucket(records: SalesRecord[]): SalesBucket {
  const units = records.reduce((sum, item) => sum + item.unitsSold, 0);
  return {
    days: records.length,
    units,
    averageUnits: records.length ? units / records.length : 0,
  };
}

function recentTrend(records: SalesRecord[], observedThrough: string): number | null {
  const latest = Date.parse(`${observedThrough}T00:00:00.000Z`);
  const recent = records.filter((row) => {
    const age = Math.floor((latest - Date.parse(`${row.salesDate}T00:00:00.000Z`)) / 86_400_000);
    return age >= 0 && age < 14;
  });
  const previous = records.filter((row) => {
    const age = Math.floor((latest - Date.parse(`${row.salesDate}T00:00:00.000Z`)) / 86_400_000);
    return age >= 14 && age < 28;
  });
  if (recent.length < 7 || previous.length < 7) return null;

  const recentAverage = recent.reduce((sum, row) => sum + row.unitsSold, 0) / recent.length;
  const previousAverage = previous.reduce((sum, row) => sum + row.unitsSold, 0) / previous.length;
  if (previousAverage === 0) return null;
  return (recentAverage - previousAverage) / previousAverage;
}

export function buildSalesSummary(rows: SalesRecord[]): SalesSummary {
  const dates = rows.map((row) => row.salesDate).sort();
  const observedFrom = dates[0] ?? null;
  const observedThrough = dates.at(-1) ?? null;
  const calendarDaysCovered = observedFrom && observedThrough
    ? daysBetween(observedFrom, observedThrough)
    : 0;
  const grouped = new Map<string, SalesRecord[]>();

  for (const row of rows) {
    const list = grouped.get(row.productName) ?? [];
    list.push(row);
    grouped.set(row.productName, list);
  }

  const products: Record<string, ProductSalesSummary> = {};
  for (const [productName, records] of grouped) {
    const weekdays: Record<string, SalesRecord[]> = {};
    const months: Record<string, SalesRecord[]> = {};
    const holidays = records.filter((row) => row.isPublicHoliday);
    const ordinary = records.filter((row) => !row.isPublicHoliday);

    for (const row of records) {
      const weekday = WEEKDAYS[utcDay(row.salesDate)];
      const month = String(Number(row.salesDate.slice(5, 7)));
      (weekdays[weekday] ??= []).push(row);
      (months[month] ??= []).push(row);
    }

    const latestForProduct = records.map((row) => row.salesDate).sort().at(-1);
    const units = records.reduce((sum, row) => sum + row.unitsSold, 0);
    products[productName] = {
      daysWithSalesData: records.length,
      totalUnits: units,
      averageUnitsPerDay: records.length ? units / records.length : 0,
      byWeekday: Object.fromEntries(Object.entries(weekdays).map(([key, values]) => [key, bucket(values)])),
      byMonth: Object.fromEntries(Object.entries(months).map(([key, values]) => [key, bucket(values)])),
      recentTrendPercent: latestForProduct ? recentTrend(records, latestForProduct) : null,
      publicHoliday: {
        holidayDays: holidays.length,
        holidayAverage: holidays.length ? bucket(holidays).averageUnits : null,
        ordinaryDays: ordinary.length,
        ordinaryAverage: ordinary.length ? bucket(ordinary).averageUnits : null,
      },
    };
  }

  const limitations: string[] = [];
  const containsSyntheticData = rows.some((row) => row.source !== "imported");
  if (containsSyntheticData) {
    limitations.push("Sales history contains synthetic demo data; forecasts are indicative only.");
  }
  if (calendarDaysCovered < 28) limitations.push("At least 28 calendar days of sales history are required.");
  if (rows.length === 0) limitations.push("No sales history is available.");
  if (Object.keys(products).length === 0) limitations.push("No products have sales records.");

  return {
    source: rows.length === 0
      ? "Supabase sales_history; no usable history is available"
      : containsSyntheticData
        ? "Supabase sales_history with synthetic demo data"
        : "Supabase sales_history imported records",
    observedFrom,
    observedThrough,
    calendarDaysCovered,
    recordCount: rows.length,
    sufficientHistory: calendarDaysCovered >= 28 && Object.keys(products).length > 0,
    limitations,
    products,
  };
}

export function salesRowsFromDatabase(rows: Record<string, unknown>[]): SalesRecord[] {
  return rows.map((row) => {
    const salesDate = row.sales_date;
    const productName = row.product_name;
    const unitsSold = row.units_sold;
    const isPublicHoliday = row.is_public_holiday;
    const source = row.source;
    if (typeof salesDate !== "string" || typeof productName !== "string" || !productName.trim()) {
      throw new Error("Sales history contains an invalid date or product.");
    }
    if (typeof unitsSold !== "number" || !Number.isSafeInteger(unitsSold) || unitsSold < 0) {
      throw new Error(`Sales history contains invalid units for ${productName}.`);
    }
    if (typeof isPublicHoliday !== "boolean") {
      throw new Error(`Sales history is missing the public-holiday value for ${productName}.`);
    }
    if (source !== "synthetic_demo" && source !== "imported") {
      throw new Error(`Sales history has an unknown source for ${productName}.`);
    }
    const date = new Date(`${salesDate}T00:00:00.000Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(salesDate)
      || !Number.isFinite(date.getTime())
      || date.toISOString().slice(0, 10) !== salesDate) {
      throw new Error("Sales history contains an invalid date.");
    }
    return { salesDate, productName: productName.trim(), unitsSold, isPublicHoliday, source };
  });
}
