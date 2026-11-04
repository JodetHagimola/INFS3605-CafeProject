import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateRestockSuggestion,
  calculateStockAttention,
  calculateTrafficForecast,
  trafficHeadline,
} from "../lib/agent/brief-calculations.ts";

function daysAgo(date, days) {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

function weeklySales(date) {
  const rows = [];
  for (let days = 1; days <= 28; days += 1) {
    const salesDate = daysAgo(date, days);
    const weekDay = new Date(`${salesDate}T00:00:00.000Z`).getUTCDay();
    rows.push({
      salesDate,
      productName: "Latte",
      unitsSold: weekDay === 3 ? 100 : 80,
      isPublicHoliday: false,
    });
  }
  return rows;
}

test("traffic forecast computes same-weekday average, range, label and product share", () => {
  const forecast = calculateTrafficForecast(weeklySales("2026-11-04"), "2026-11-04", false);

  assert.ok(forecast);
  assert.equal(forecast.weekday, "Wednesday");
  assert.equal(forecast.expected, 100);
  assert.equal(forecast.low, 100);
  assert.equal(forecast.high, 100);
  assert.equal(forecast.label, "busy");
  assert.equal(forecast.productShares.get("Latte"), 1);
  assert.match(trafficHeadline(forecast), /about 100 drinks expected/);
});

test("public holidays apply the deterministic 20 percent adjustment", () => {
  const forecast = calculateTrafficForecast(weeklySales("2026-11-04"), "2026-11-04", true);
  assert.ok(forecast);
  assert.equal(forecast.expected, 80);
  assert.equal(forecast.low, 80);
  assert.equal(forecast.high, 80);
});

test("traffic forecast refuses insufficient weekday history", () => {
  const rows = weeklySales("2026-11-04").filter((row) => row.salesDate >= "2026-10-28");
  assert.equal(calculateTrafficForecast(rows, "2026-11-04", false), null);
});

test("stock attention flags current or projected shortfalls and ranks urgency", () => {
  const items = calculateStockAttention({
    ingredients: [
      { id: "milk", name: "Milk", unit: "ml" },
      { id: "beans", name: "Beans", unit: "g" },
      { id: "cups", name: "Cups", unit: "pcs" },
      { id: "sugar", name: "Sugar", unit: "g" },
    ],
    inventory: [
      { id: "milk", quantity: 800, minimum: 1000 },
      { id: "beans", quantity: 5000, minimum: 1000 },
      { id: "cups", quantity: 200, minimum: 100 },
      { id: "sugar", quantity: 500, minimum: null },
    ],
    recipes: [
      { product: "Latte", ingredientId: "milk", quantityRequired: 200 },
      { product: "Latte", ingredientId: "beans", quantityRequired: 20 },
    ],
    usageAvailable: true,
    traffic: {
      label: "typical",
      weekday: "Wednesday",
      expected: 10,
      low: 8,
      high: 12,
      recentAverage: 10,
      percentFromAverage: 0,
      sameWeekdayDays: 4,
      productShares: new Map([["Latte", 1]]),
    },
    incomingByIngredient: new Map([["milk", 300]]),
  });

  assert.deepEqual(items.map((item) => item.ingredientId), ["milk"]);
  assert.match(items[0].status, /Below min/);
});

test("restock suggestions convert base units and honor supplier minimums", () => {
  const suggestion = calculateRestockSuggestion({
    item: {
      ingredientId: "milk",
      ingredient: "Milk",
      quantity: 1000,
      minimum: 500,
      unit: "ml",
      status: "Low",
      urgency: 0,
      projectedUsage: 1000,
      incomingToday: 0,
    },
    incomingWithinThreeDays: 500,
    incomingIsReliable: true,
    supplierOffers: [
      { supplier: "Demo Local Dairy", price: 0.0042, deliveryTime: "Next day", minimumOrder: 1000 },
      { supplier: "Supplier A", price: 1.5, deliveryTime: "Next day", minimumOrder: 2 },
      { supplier: "Supplier B", price: 1.7, deliveryTime: "2 business days", minimumOrder: 1 },
    ],
  });

  assert.deepEqual(suggestion, {
    quantity: 2,
    unit: "L",
    supplier: "Supplier A",
    estimatedCost: 3,
  });
});

test("supplier choice prefers a deliverable offer over a cheaper late offer", () => {
  const suggestion = calculateRestockSuggestion({
    item: {
      ingredientId: "milk",
      ingredient: "Milk",
      quantity: 0,
      minimum: 100,
      unit: "ml",
      status: "Low",
      urgency: 1,
      projectedUsage: 100,
      incomingToday: 0,
    },
    incomingWithinThreeDays: 0,
    incomingIsReliable: true,
    supplierOffers: [
      { supplier: "Fast Supplier", price: 5, deliveryTime: "Next day", minimumOrder: 0 },
      { supplier: "Slow Supplier", price: 1, deliveryTime: "2 business days", minimumOrder: 0 },
    ],
  });

  assert.equal(suggestion.supplier, "Fast Supplier");
});

test("restock suggestions stay unknown when projected usage or deliveries are unavailable", () => {
  const item = {
    ingredientId: "milk",
    ingredient: "Milk",
    quantity: 1000,
    minimum: 500,
    unit: "ml",
    status: "Low",
    urgency: 0,
    projectedUsage: null,
    incomingToday: 0,
  };
  const suggestion = calculateRestockSuggestion({
    item,
    incomingWithinThreeDays: 0,
    incomingIsReliable: true,
    supplierOffers: [],
  });
  assert.equal(suggestion.quantity, null);
  assert.equal(suggestion.supplier, null);

  const deliveriesUnknown = calculateRestockSuggestion({
    item: { ...item, projectedUsage: 1000 },
    incomingWithinThreeDays: 0,
    incomingIsReliable: false,
    supplierOffers: [],
  });
  assert.equal(deliveriesUnknown.quantity, null);
});
