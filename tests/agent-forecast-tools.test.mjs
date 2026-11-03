import assert from "node:assert/strict";
import test from "node:test";
import { buildSalesSummary } from "../lib/agent/tools/sales-summary-model.ts";
import { validateAgentForecast } from "../lib/agent/tools/forecast-model.ts";
import { shortfallAmount } from "../lib/agent/tools/shortfall-model.ts";

function history(days = 56) {
  const rows = [];
  const firstDay = Date.UTC(2026, 0, 1);
  for (let offset = 0; offset < days; offset += 1) {
    const date = new Date(firstDay + offset * 86_400_000).toISOString().slice(0, 10);
    rows.push({
      salesDate: date,
      productName: "Latte",
      unitsSold: 20 + new Date(date).getUTCDay(),
      isPublicHoliday: false,
    });
  }
  return rows;
}

function forecastProposal(overrides = {}) {
  return {
    startDate: "2026-03-02",
    dailyForecasts: [{
      date: "2026-03-02",
      products: { Latte: { low: 20, expected: 25, high: 30 } },
    }],
    assumptions: ["The weekday average is used as the baseline."],
    ...overrides,
  };
}

test("sales summary computes weekday, month, trend, and holiday aggregates", () => {
  const summary = buildSalesSummary(history());
  assert.equal(summary.sufficientHistory, true);
  assert.equal(summary.calendarDaysCovered, 56);
  assert.equal(summary.products.Latte.byWeekday.Monday.days, 8);
  assert.equal(summary.products.Latte.byMonth["1"].days, 31);
  assert.equal(summary.products.Latte.publicHoliday.holidayDays, 0);
  assert.equal(typeof summary.products.Latte.recentTrendPercent, "number");
});

test("Gemini forecast is validated and its period totals are calculated in code", () => {
  const summary = buildSalesSummary(history());
  const result = validateAgentForecast(summary, forecastProposal({ isPublicHoliday: false }));
  assert.equal(result.status, "ready");
  assert.equal(result.dailyForecasts.length, 1);
  const latte = result.dailyForecasts[0].products.Latte;
  assert.ok(Number.isSafeInteger(latte.low));
  assert.ok(Number.isSafeInteger(latte.expected));
  assert.ok(Number.isSafeInteger(latte.high));
  assert.ok(latte.low <= latte.expected && latte.expected <= latte.high);
  assert.equal(result.totals.Latte.expected, 25);
  assert.match(result.source, /Gemini AI estimate/);
});

test("forecast stops rather than accepting Gemini predictions with insufficient history", () => {
  const summary = buildSalesSummary(history(12));
  const result = validateAgentForecast(summary, forecastProposal());
  assert.equal(result.status, "insufficient_history");
  assert.deepEqual(result.dailyForecasts, []);
  assert.ok(result.flags.length > 0);
});

test("forecast validates dates, products, and ordered nonnegative ranges", () => {
  const summary = buildSalesSummary(history());
  assert.throws(
    () => validateAgentForecast(summary, forecastProposal({
      endDate: "2026-04-02",
      dailyForecasts: [],
    })),
    /no more than 31 days/,
  );
  assert.throws(
    () => validateAgentForecast(summary, forecastProposal({
      dailyForecasts: [{
        date: "2026-03-02",
        products: { Latte: { low: 30, expected: 20, high: 25 } },
      }],
    })),
    /whole, nonnegative, and ordered/,
  );
  assert.throws(
    () => validateAgentForecast(summary, forecastProposal({
      dailyForecasts: [{
        date: "2026-03-02",
        products: { Mocha: { low: 1, expected: 2, high: 3 } },
      }],
    })),
    /every product/,
  );
});

test("shortfalls subtract stock and incoming delivery without becoming negative", () => {
  assert.equal(shortfallAmount(24, 8, 6), 10);
  assert.equal(shortfallAmount(12, 12, 8), 0);
  assert.equal(shortfallAmount(12, 4, 8), 0);
  assert.throws(() => shortfallAmount(-1, 0, 0), /finite and nonnegative/);
});
