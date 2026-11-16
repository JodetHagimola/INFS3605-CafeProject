const QUANTITY_SCALE = BigInt(1_000_000);
const PRICE_SCALE = BigInt(1_000_000);
const CENTS_SCALE = BigInt(10_000_000_000);

export type SupplierQuote = {
  supplier: string;
  price: string;
  minimumOrder: string;
  packSize: string;
  packLabel: string | null;
  leadTimeDays: number;
  active: boolean;
  contactEmail: string | null;
};

export type IncomingQuantity = { quantity: string; expectedDate: string };
export type ReorderRule = { supplier: string; packs: number; orderLimit: string; enabled: boolean };
export type OrderingCandidate = {
  supplier: string;
  packs: number;
  stockAmount: string;
  packSize: string;
  packLabel: string | null;
  expectedDate: string;
  unitPrice: string;
  minimumOrder: string;
  totalCents: number;
  active: boolean;
  hasContact: boolean;
  autoEligible: boolean;
  flags: string[];
};

type PlanInput = {
  today: string;
  stock: string | null;
  minimum: string | null;
  averageDailyUsage: string | null;
  incoming: IncomingQuantity[];
  quotes: SupplierQuote[];
  rule: ReorderRule | null;
  autoOrderLimit: string;
  dailyLimit: string;
  weeklyLimit: string | null;
  committedToday: string;
  committedThisWeek: string;
};

export type OrderingPlan =
  | { status: "no_action"; reason: string }
  | { status: "blocked"; flags: string[] }
  | { status: "order"; candidate: OrderingCandidate };

function fixed(value: string, field: string, scale = QUANTITY_SCALE): bigint {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error(`${field} must be a nonnegative decimal with at most six decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * scale + BigInt(fraction.padEnd(6, "0"));
}

function formatQuantity(value: bigint): string {
  const whole = value / QUANTITY_SCALE;
  const fraction = (value % QUANTITY_SCALE).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function validDate(value: string, field: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be an ISO calendar date.`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error(`${field} must be an ISO calendar date.`);
  }
  return timestamp;
}

function addDays(date: string, days: number): string {
  const timestamp = validDate(date, "Expected date") + days * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function moneyCents(value: string, field: string): number {
  if (!/^(?:0|[1-9]\d{0,7})(?:\.\d{1,2})?$/.test(value)) {
    throw new Error(`${field} must be a nonnegative amount with at most two decimal places.`);
  }
  const [whole, fraction = ""] = value.split(".");
  const cents = BigInt(whole) * BigInt(100) + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field} is too large.`);
  return Number(cents);
}

function priceMicros(value: string): bigint {
  return fixed(value, "Supplier price", PRICE_SCALE);
}

function totalCents(packSize: bigint, price: bigint, packs: number): number {
  const numerator = packSize * price * BigInt(packs);
  const cents = (numerator + CENTS_SCALE / BigInt(2)) / CENTS_SCALE;
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Order total is too large.");
  return Number(cents);
}

function dateEligibleIncoming(
  incoming: IncomingQuantity[],
  arrivalDate: string,
): bigint {
  return incoming.reduce((total, item) => {
    const expected = validDate(item.expectedDate, "Incoming delivery date");
    const arrival = validDate(arrivalDate, "Supplier arrival date");
    return expected <= arrival ? total + fixed(item.quantity, "Incoming quantity") : total;
  }, BigInt(0));
}

export function calculateOrderingPlan(input: PlanInput): OrderingPlan {
  const today = validDate(input.today, "Today");
  if (!input.stock || !input.minimum || !input.averageDailyUsage) {
    return { status: "blocked", flags: ["Stock, minimum stock, or recent usage is unavailable."] };
  }
  if (!input.quotes.length) {
    return { status: "blocked", flags: ["No supplier price is available for this ingredient."] };
  }

  const stock = fixed(input.stock, "Current stock");
  const minimum = fixed(input.minimum, "Minimum stock");
  const dailyUsage = fixed(input.averageDailyUsage, "Average daily usage");
  if (minimum <= BigInt(0) || dailyUsage <= BigInt(0)) {
    return { status: "blocked", flags: ["A positive minimum and recent average usage are required."] };
  }

  const rule = input.rule;
  if (rule && (!Number.isInteger(rule.packs) || rule.packs < 1 || rule.packs > 10_000)) {
    throw new Error("The normal reorder pack count is invalid.");
  }
  const candidates = input.quotes.flatMap((quote) => {
    if (!quote.supplier.trim() || !Number.isInteger(quote.leadTimeDays)
      || quote.leadTimeDays < 0 || quote.leadTimeDays > 365) {
      return [];
    }
    const packSize = fixed(quote.packSize, "Supplier pack size");
    if (packSize <= BigInt(0)) return [];
    const price = priceMicros(quote.price);
    const minimumOrder = fixed(quote.minimumOrder, "Supplier minimum order");
    const expectedDate = addDays(input.today, quote.leadTimeDays);
    const incoming = dateEligibleIncoming(input.incoming, expectedDate);
    const projectedStock = stock + incoming - dailyUsage * BigInt(quote.leadTimeDays);
    if (projectedStock >= minimum) return [];
    const shortfall = minimum - projectedStock;
    const packsNeeded = Number((shortfall + packSize - BigInt(1)) / packSize);
    const minimumPacks = Number((minimumOrder + packSize - BigInt(1)) / packSize);
    const packs = Math.max(1, packsNeeded, minimumPacks);
    if (!Number.isSafeInteger(packs) || packs > 10_000) return [];

    return [{
      supplier: quote.supplier,
      packs,
      stockAmount: formatQuantity(packSize * BigInt(packs)),
      packSize: formatQuantity(packSize),
      packLabel: quote.packLabel,
      expectedDate,
      unitPrice: quote.price,
      minimumOrder: formatQuantity(minimumOrder),
      totalCents: totalCents(packSize, price, packs),
      active: quote.active,
      hasContact: !!quote.contactEmail?.trim(),
      rule,
      perOrderLimitCents: moneyCents(
        rule?.orderLimit ?? input.autoOrderLimit,
        "Per-order limit",
      ),
    }];
  });

  if (!candidates.length) {
    return { status: "no_action", reason: "Projected stock stays above the minimum before eligible supplier arrivals." };
  }

  const preferred = rule ? candidates.find((candidate) => candidate.supplier === rule.supplier) : undefined;
  const candidate = preferred ?? candidates.sort((left, right) =>
    left.totalCents - right.totalCents
      || left.expectedDate.localeCompare(right.expectedDate)
      || left.supplier.localeCompare(right.supplier))[0];
  const flags: string[] = [];
  const applicableOrderLimit = Math.min(
    candidate.perOrderLimitCents,
    moneyCents(input.autoOrderLimit, "Automatic order limit"),
  );
  const dailyLimit = moneyCents(input.dailyLimit, "Daily spending limit");
  const weeklyLimit = input.weeklyLimit === null ? null : moneyCents(input.weeklyLimit, "Weekly spending limit");
  const spentToday = moneyCents(input.committedToday, "Today's committed spend");
  const spentThisWeek = moneyCents(input.committedThisWeek, "This week's committed spend");

  if (!candidate.active) flags.push("Supplier is inactive.");
  if (!candidate.hasContact) flags.push("Supplier contact details are missing.");
  if (!rule?.enabled) flags.push("No enabled reorder rule matches this supplier.");
  if (rule && candidate.packs > rule.packs * 2) flags.push("Required quantity exceeds twice the normal rule quantity.");
  if (candidate.totalCents > applicableOrderLimit) flags.push("Order total exceeds the automatic per-order limit.");
  if (spentToday + candidate.totalCents > dailyLimit) flags.push("Order would exceed the daily spending limit.");
  if (weeklyLimit !== null && spentThisWeek + candidate.totalCents > weeklyLimit) {
    flags.push("Order would exceed the weekly spending limit.");
  }

  return {
    status: "order",
    candidate: {
      supplier: candidate.supplier,
      packs: candidate.packs,
      stockAmount: candidate.stockAmount,
      packSize: candidate.packSize,
      packLabel: candidate.packLabel,
      expectedDate: candidate.expectedDate,
      unitPrice: candidate.unitPrice,
      minimumOrder: candidate.minimumOrder,
      totalCents: candidate.totalCents,
      active: candidate.active,
      hasContact: candidate.hasContact,
      autoEligible: flags.length === 0,
      flags,
    },
  };
}
