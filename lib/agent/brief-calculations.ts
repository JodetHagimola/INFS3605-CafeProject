export type BriefSalesRow = {
  salesDate: string;
  productName: string;
  unitsSold: number;
  isPublicHoliday: boolean;
};

export type TrafficForecast = {
  label: "busy" | "quiet" | "typical";
  weekday: string;
  expected: number;
  low: number;
  high: number;
  recentAverage: number;
  percentFromAverage: number;
  sameWeekdayDays: number;
  productShares: Map<string, number>;
};

export type StockAttention = {
  ingredientId: string;
  ingredient: string;
  quantity: number;
  minimum: number;
  unit: string;
  status: string;
  urgency: number;
  projectedUsage: number | null;
  incomingToday: number;
};

export type SupplierOffer = {
  supplier: string;
  price: number;
  deliveryTime: string;
  minimumOrder: number;
};

export type RestockSuggestion = {
  quantity: number | null;
  unit: string;
  supplier: string | null;
  estimatedCost: number | null;
};

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_MS = 24 * 60 * 60 * 1000;

function dayOffset(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay();
}

function roundedCount(value: number): number {
  return Math.max(0, Math.round(value));
}

export function calculateTrafficForecast(
  rows: BriefSalesRow[],
  date: string,
  publicHoliday: boolean,
): TrafficForecast | null {
  const start = dayOffset(date, -56);
  const recentStart = dayOffset(date, -28);
  const dailyTotals = new Map<string, { total: number; publicHoliday: boolean }>();
  const productTotals = new Map<string, number>();

  for (const row of rows) {
    if (row.salesDate < start || row.salesDate >= date) continue;
    const daily = dailyTotals.get(row.salesDate) ?? { total: 0, publicHoliday: false };
    daily.total += row.unitsSold;
    daily.publicHoliday ||= row.isPublicHoliday;
    dailyTotals.set(row.salesDate, daily);
  }

  const weekday = weekdayIndex(date);
  const sameWeekday = [...dailyTotals.entries()]
    .filter(([salesDate, totals]) => weekdayIndex(salesDate) === weekday && !totals.publicHoliday);
  const recentDays = [...dailyTotals.entries()]
    .filter(([salesDate]) => salesDate >= recentStart);
  if (sameWeekday.length < 3 || recentDays.length < 7) return null;

  for (const row of rows) {
    const daily = dailyTotals.get(row.salesDate);
    if (daily && weekdayIndex(row.salesDate) === weekday && !daily.publicHoliday) {
      productTotals.set(row.productName, (productTotals.get(row.productName) ?? 0) + row.unitsSold);
    }
  }

  const weekdayTotals = sameWeekday.map(([, totals]) => totals.total);
  const baseline = weekdayTotals.reduce((sum, total) => sum + total, 0) / weekdayTotals.length;
  const recentAverage = recentDays.reduce((sum, [, totals]) => sum + totals.total, 0) / recentDays.length;
  const factor = publicHoliday ? 0.8 : 1;
  const expected = roundedCount(baseline * factor);
  const low = Math.min(expected, Math.floor(Math.min(...weekdayTotals) * factor));
  const high = Math.max(expected, Math.ceil(Math.max(...weekdayTotals) * factor));
  const percentFromAverage = recentAverage > 0
    ? (expected - recentAverage) / recentAverage
    : 0;
  const label = percentFromAverage >= 0.1
    ? "busy"
    : percentFromAverage <= -0.1
      ? "quiet"
      : "typical";
  const productTotal = [...productTotals.values()].reduce((sum, total) => sum + total, 0);

  return {
    label,
    weekday: WEEKDAYS[weekday],
    expected,
    low,
    high,
    recentAverage,
    percentFromAverage,
    sameWeekdayDays: sameWeekday.length,
    productShares: new Map(
      [...productTotals].map(([product, total]) => [product, productTotal > 0 ? total / productTotal : 0]),
    ),
  };
}

export function calculateStockAttention(input: {
  ingredients: Array<{ id: string; name: string; unit: string }>;
  inventory: Array<{ id: string; quantity: number | null; minimum: number | null }>;
  recipes: Array<{ product: string; ingredientId: string; quantityRequired: number }>;
  traffic: TrafficForecast | null;
  usageAvailable: boolean;
  incomingByIngredient: ReadonlyMap<string, number>;
  deliveryIssues?: ReadonlySet<string>;
}): StockAttention[] {
  const inventoryById = new Map(input.inventory.map((item) => [item.id, item]));
  const usageByIngredient = new Map<string, number>();

  if (input.traffic) {
    for (const recipe of input.recipes) {
      const share = input.traffic.productShares.get(recipe.product) ?? 0;
      const usage = input.traffic.expected * share * recipe.quantityRequired;
      usageByIngredient.set(
        recipe.ingredientId,
        (usageByIngredient.get(recipe.ingredientId) ?? 0) + usage,
      );
    }
  }

  return input.ingredients.flatMap((ingredient) => {
    const stock = inventoryById.get(ingredient.id);
    if (!stock || stock.quantity === null || stock.minimum === null) return [];
    const incoming = input.incomingByIngredient.get(ingredient.id) ?? 0;
    const usage = input.usageAvailable ? usageByIngredient.get(ingredient.id) ?? 0 : null;
    const projected = usage === null ? null : stock.quantity + incoming - usage;
    if (stock.quantity >= stock.minimum && (projected === null || projected >= stock.minimum)) return [];

    const urgency = usage !== null && usage > 0
      ? (stock.quantity + incoming - stock.minimum) / usage
      : stock.quantity - stock.minimum;
    const deliveryNote = input.deliveryIssues?.has(ingredient.id) ? "; delivery overdue/short" : "";
    const status = stock.quantity < stock.minimum
      ? usage === null
        ? `Below min (${stock.minimum} ${ingredient.unit}); today's usage is unknown${deliveryNote}.`
        : `Below min (${stock.minimum} ${ingredient.unit}); usage ~${roundedCount(usage)} ${ingredient.unit}${deliveryNote}.`
      : `Projected below min today; usage ~${roundedCount(usage ?? 0)} ${ingredient.unit}${deliveryNote}.`;
    return [{
      ingredientId: ingredient.id,
      ingredient: ingredient.name,
      quantity: stock.quantity,
      minimum: stock.minimum,
      unit: ingredient.unit,
      status,
      urgency,
      projectedUsage: usage,
      incomingToday: incoming,
    }];
  }).sort((left, right) => left.urgency - right.urgency);
}

export function calculateRestockSuggestion(input: {
  item: StockAttention;
  incomingWithinThreeDays: number;
  supplierOffers: SupplierOffer[];
  incomingIsReliable: boolean;
}): RestockSuggestion {
  const purchaseUnit = input.item.unit === "ml"
    ? { unit: "L", factor: 1000 }
    : input.item.unit === "g"
      ? { unit: "kg", factor: 1000 }
      : { unit: "pcs", factor: 1 };
  const usage = input.item.projectedUsage;
  if (usage === null || !input.incomingIsReliable) {
    return { quantity: null, unit: purchaseUnit.unit, supplier: null, estimatedCost: null };
  }

  const needed = Math.max(
    0,
    (3 * usage - input.item.quantity - input.incomingWithinThreeDays) / purchaseUnit.factor,
  );
  if (needed === 0) {
    return { quantity: 0, unit: purchaseUnit.unit, supplier: null, estimatedCost: 0 };
  }

  const offers = input.supplierOffers
    .filter((offer) => !/^demo\b/i.test(offer.supplier))
    .map((offer) => {
      const quantity = Math.ceil(Math.max(needed, offer.minimumOrder));
      const estimatedCost = Math.round(quantity * offer.price * 100) / 100;
      return {
        ...offer,
        quantity,
        estimatedCost,
        deliveryDays: supplierDeliveryDays(offer.deliveryTime),
      };
    })
    .sort((left, right) => {
      const leftCanArriveBeforeShortage = left.deliveryDays <= Math.max(0, input.item.urgency);
      const rightCanArriveBeforeShortage = right.deliveryDays <= Math.max(0, input.item.urgency);
      if (leftCanArriveBeforeShortage !== rightCanArriveBeforeShortage) {
        return leftCanArriveBeforeShortage ? -1 : 1;
      }
      if (!leftCanArriveBeforeShortage && left.deliveryDays !== right.deliveryDays) {
        return left.deliveryDays - right.deliveryDays;
      }
      return left.estimatedCost - right.estimatedCost || left.price - right.price;
    });
  const selected = offers[0];
  if (!selected) {
    return { quantity: Math.ceil(needed), unit: purchaseUnit.unit, supplier: null, estimatedCost: null };
  }
  return {
    quantity: selected.quantity,
    unit: purchaseUnit.unit,
    supplier: selected.supplier,
    estimatedCost: selected.estimatedCost,
  };
}

function supplierDeliveryDays(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (/^(today|same day)$/.test(normalized)) return 0;
  if (/^next day$/.test(normalized)) return 1;
  const matches = [...normalized.matchAll(/\d+/g)].map((match) => Number(match[0]));
  return matches.length > 0 ? Math.max(...matches) : Number.POSITIVE_INFINITY;
}

export function trafficHeadline(forecast: TrafficForecast): string {
  const expected = new Intl.NumberFormat("en-AU").format(forecast.expected);
  const low = new Intl.NumberFormat("en-AU").format(forecast.low);
  const high = new Intl.NumberFormat("en-AU").format(forecast.high);
  const comparison = Math.round(Math.abs(forecast.percentFromAverage) * 100);
  const relative = forecast.percentFromAverage > 0.01
    ? `, about ${comparison}% above a normal day`
    : forecast.percentFromAverage < -0.01
      ? `, about ${comparison}% below a normal day`
      : ", around a normal day";
  return `${forecast.label[0].toUpperCase()}${forecast.label.slice(1)} ${forecast.weekday}: about ${expected} drinks expected (${low}-${high})${relative}.`;
}
