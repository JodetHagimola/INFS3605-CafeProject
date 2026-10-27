import assert from "node:assert/strict";
import test from "node:test";
import { forecastDrinkSales } from "../lib/agent/forecast.ts";

const products = ["Latte", "Cappuccino", "Flat White", "Long Black", "Mocha"];

function dateFor(month, dayNumber) {
  for (let day = 1; day <= 31; day += 1) {
    const date = new Date(Date.UTC(2026, month - 1, day));
    if (date.getUTCMonth() === month - 1 && (date.getUTCDay() + 6) % 7 === dayNumber) {
      return date.toISOString().slice(0, 10);
    }
  }
  throw new Error(`No date found for month ${month}, weekday ${dayNumber}.`);
}

test("the saved forecast covers every month, weekday, and holiday selection", () => {
  for (let month = 1; month <= 12; month += 1) {
    for (let dayNumber = 0; dayNumber < 7; dayNumber += 1) {
      const forecastDate = dateFor(month, dayNumber);
      for (const isPublicHoliday of [false, true]) {
        const forecast = forecastDrinkSales(forecastDate, isPublicHoliday);
        assert.equal(forecast.forecastDate, forecastDate);
        assert.equal(forecast.isPublicHoliday, isPublicHoliday);
        assert.deepEqual(Object.keys(forecast.predictedSales), products);
        for (const sales of Object.values(forecast.predictedSales)) {
          assert.ok(Number.isSafeInteger(sales) && sales >= 0);
        }
      }
    }
  }
});

test("rejects invalid forecast dates", () => {
  assert.throws(() => forecastDrinkSales("2026-02-30", false), /valid forecast date/);
});
