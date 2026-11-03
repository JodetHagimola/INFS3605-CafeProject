import type { SalesSummary } from "./sales-summary-model";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export type ForecastDay = {
  date: string;
  publicHoliday: boolean | null;
  products: Record<string, { low: number; expected: number; high: number }>;
};

export type DemandForecast = {
  startDate: string;
  endDate: string;
  status: "ready" | "insufficient_history";
  source: string;
  assumptions: string[];
  flags: string[];
  dailyForecasts: ForecastDay[];
  totals: Record<string, { low: number; expected: number; high: number }>;
};

export type AgentForecastProposal = {
  startDate: string;
  endDate?: string;
  isPublicHoliday?: boolean;
  dailyForecasts: Array<{
    date: string;
    products: Record<string, { low: number; expected: number; high: number }>;
  }>;
  assumptions: string[];
};

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function dateRange(start: string, end: string): string[] {
  if (!validDate(start) || !validDate(end) || end < start) {
    throw new Error("Choose a valid forecast date range.");
  }
  const count = (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / 86_400_000 + 1;
  if (count > 31) throw new Error("A single forecast can cover no more than 31 days.");
  return Array.from({ length: count }, (_, index) =>
    new Date(Date.parse(`${start}T00:00:00.000Z`) + index * 86_400_000).toISOString().slice(0, 10));
}

export function validateAgentForecast(
  summary: SalesSummary,
  proposal: AgentForecastProposal,
): DemandForecast {
  const endDate = proposal.endDate ?? proposal.startDate;
  const dates = dateRange(proposal.startDate, endDate);

  const assumptions = [
    ...proposal.assumptions.map((assumption) => assumption.trim()),
    "Forecasts are indicative Gemini AI estimates based on available sales history, which may be synthetic.",
  ];
  const source = `Gemini AI estimate based on available sales history (${summary.source}).`;
  if (!summary.sufficientHistory) {
    return {
      startDate: proposal.startDate,
      endDate,
      status: "insufficient_history",
      source,
      assumptions,
      flags: summary.limitations.length
        ? summary.limitations
        : ["Sales history is too limited to forecast reliably."],
      dailyForecasts: [],
      totals: {},
    };
  }

  const products = Object.keys(summary.products);
  if (!products.length || proposal.dailyForecasts.length !== dates.length) {
    throw new Error("Gemini must forecast every date and product in the sales summary.");
  }

  const totals: DemandForecast["totals"] = {};
  const dailyForecasts: ForecastDay[] = [];
  let missingHolidayEffect = false;
  for (const [index, date] of dates.entries()) {
    const proposedDay = proposal.dailyForecasts[index];
    if (proposedDay.date !== date) {
      throw new Error("Gemini forecast dates must exactly match the requested period.");
    }

    const productNames = Object.keys(proposedDay.products);
    if (productNames.length !== products.length || products.some((name) => !(name in proposedDay.products))) {
      throw new Error("Gemini must forecast every product in the sales summary, without adding products.");
    }

    const weekday = WEEKDAYS[new Date(`${date}T00:00:00.000Z`).getUTCDay()];
    const productForecasts: ForecastDay["products"] = {};
    for (const productName of products) {
      if ((summary.products[productName].byWeekday[weekday]?.days ?? 0) < 3) {
        return {
          startDate: proposal.startDate,
          endDate,
          status: "insufficient_history",
          source,
          assumptions,
          flags: [`There are fewer than three matching-weekday sales observations for ${productName}; no forecast was produced.`],
          dailyForecasts: [],
          totals: {},
        };
      }

      const estimate = proposedDay.products[productName];
      if (![estimate.low, estimate.expected, estimate.high].every(Number.isSafeInteger)
        || estimate.low < 0
        || estimate.low > estimate.expected
        || estimate.expected > estimate.high) {
        throw new Error(`Gemini forecast values for ${productName} must be whole, nonnegative, and ordered low to high.`);
      }

      productForecasts[productName] = estimate;
      const total = totals[productName] ?? { low: 0, expected: 0, high: 0 };
      const nextTotal = {
        low: total.low + estimate.low,
        expected: total.expected + estimate.expected,
        high: total.high + estimate.high,
      };
      if (![nextTotal.low, nextTotal.expected, nextTotal.high].every(Number.isSafeInteger)) {
        throw new Error(`Gemini forecast totals for ${productName} exceed the supported range.`);
      }
      totals[productName] = nextTotal;
    }

    const isPublicHoliday = date === proposal.startDate
      ? proposal.isPublicHoliday ?? null
      : null;
    if (isPublicHoliday === null) {
      missingHolidayEffect = true;
    } else if (isPublicHoliday && products.some((name) => {
      const holiday = summary.products[name].publicHoliday;
      return holiday.holidayDays < 3 || holiday.ordinaryDays < 7;
    })) {
      missingHolidayEffect = true;
    }

    dailyForecasts.push({ date, publicHoliday: isPublicHoliday, products: productForecasts });
  }

  const flags = [...summary.limitations];
  if (missingHolidayEffect) {
    flags.push("Public-holiday status or enough holiday-specific history is unavailable; no holiday adjustment was verified.");
  }
  return {
    startDate: proposal.startDate,
    endDate,
    status: "ready",
    source,
    assumptions,
    flags,
    dailyForecasts,
    totals,
  };
}
