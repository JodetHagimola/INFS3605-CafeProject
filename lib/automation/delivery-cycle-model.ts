import { createHash } from "node:crypto";

export type ArrivalOutcome =
  | { kind: "complete" }
  | { kind: "short"; missingPercent: number }
  | { kind: "late" };

export type DeliveryWindowState = "not_due" | "before" | "open" | "passed" | "missing_window";
export type DeliveryFollowupAction = "none" | "chase" | "decision" | "lapse";

const DAY_MS = 24 * 60 * 60 * 1000;

export function deterministicDeliveryId(...parts: string[]): string {
  const digest = createHash("sha256").update(parts.join("\u0000")).digest().subarray(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validDate(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Expected a valid ISO calendar date.");
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value) {
    throw new Error("Expected a valid ISO calendar date.");
  }
  return timestamp;
}

function parseTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?$/.exec(value);
  if (!match) throw new Error("Supplier delivery windows must use a valid local time.");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function sydneyDate(now: Date): string {
  if (!Number.isFinite(now.getTime())) throw new Error("Delivery cycle time is invalid.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function deliveryWindowState(
  now: Date,
  expectedDate: string,
  windowStart: string | null,
  windowEnd: string | null,
): DeliveryWindowState {
  const expectedDay = validDate(expectedDate);
  const localToday = validDate(sydneyDate(now));
  if (localToday < expectedDay) return "not_due";
  if (localToday > expectedDay) return "passed";
  if (!windowStart || !windowEnd) return "missing_window";
  const start = parseTime(windowStart);
  const end = parseTime(windowEnd);
  if (start >= end) throw new Error("Supplier delivery-window start must be before its end.");

  const parts = new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const minute = Number(values.hour) * 60 + Number(values.minute);
  if (!Number.isInteger(minute) || minute < 0 || minute >= 24 * 60) {
    throw new Error("Could not determine the current Sydney local time.");
  }
  if (minute < start) return "before";
  if (minute <= end) return "open";
  return "passed";
}

export function simulateArrivalOutcome(deliveryId: string, expectedDate: string): ArrivalOutcome {
  if (!/^\d+$/.test(deliveryId)) throw new Error("Delivery ID is invalid.");
  validDate(expectedDate);
  const digest = createHash("sha256")
    .update(`brewly-delivery-simulation-v1:${deliveryId}:${expectedDate}`)
    .digest();
  const percentile = digest.readUInt32BE(0) / 0x1_0000_0000 * 100;
  if (percentile < 90) return { kind: "complete" };
  if (percentile < 97) return { kind: "short", missingPercent: 20 + digest[4] % 21 };
  return { kind: "late" };
}

function quantityMicros(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,9})(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Delivery quantity must be a nonnegative decimal with at most six decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * BigInt(1_000_000) + BigInt(fraction.padEnd(6, "0"));
}

function quantityString(value: bigint): string {
  const whole = value / BigInt(1_000_000);
  const fraction = (value % BigInt(1_000_000)).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function quantityDifference(left: string, right: string): string {
  const difference = quantityMicros(left) - quantityMicros(right);
  return quantityString(difference > BigInt(0) ? difference : BigInt(0));
}

export function sumQuantities(values: string[]): string {
  return quantityString(values.reduce((total, value) => total + quantityMicros(value), BigInt(0)));
}

export function shortageExceedsPercent(ordered: string, received: string, percent: number): boolean {
  if (!Number.isInteger(percent) || percent < 0 || percent > 100) {
    throw new Error("Shortage threshold must be a whole percentage from 0 to 100.");
  }
  const orderedMicros = quantityMicros(ordered);
  const receivedMicros = quantityMicros(received);
  if (orderedMicros <= BigInt(0)) throw new Error("Ordered delivery quantity must be positive.");
  const missing = orderedMicros > receivedMicros ? orderedMicros - receivedMicros : BigInt(0);
  return missing * BigInt(100) > orderedMicros * BigInt(percent);
}

export function simulatedReceivedQuantity(expected: string, missingPercent: number): string | null {
  if (!Number.isInteger(missingPercent) || missingPercent < 1 || missingPercent > 99) {
    throw new Error("Simulated shortage percentage is invalid.");
  }
  const expectedMicros = quantityMicros(expected);
  if (expectedMicros <= BigInt(0)) throw new Error("Expected delivery quantity must be positive.");
  const receivedMicros = expectedMicros * BigInt(100 - missingPercent) / BigInt(100);
  if (receivedMicros <= BigInt(0)) return null;
  return quantityString(receivedMicros);
}

export function withinDeliveryTolerance(expected: string, received: string): boolean {
  const expectedMicros = quantityMicros(expected);
  const receivedMicros = quantityMicros(received);
  if (expectedMicros <= BigInt(0)) throw new Error("Expected delivery quantity must be positive.");
  const difference = expectedMicros >= receivedMicros
    ? expectedMicros - receivedMicros
    : receivedMicros - expectedMicros;
  return difference * BigInt(100) <= expectedMicros * BigInt(3);
}

export function deliveryFollowupAction(
  expectedDate: string,
  today: string,
  chaseCount: number,
  lastChasedAt: string | null,
  now: Date,
): DeliveryFollowupAction {
  const expected = validDate(expectedDate);
  const current = validDate(today);
  if (!Number.isFinite(now.getTime())) throw new Error("Delivery follow-up time is invalid.");
  if (!Number.isInteger(chaseCount) || chaseCount < 0) throw new Error("Delivery chase count is invalid.");
  if (current < expected) return "none";
  const overdueDays = Math.floor((current - expected) / DAY_MS);
  if (overdueDays >= 7) return "lapse";
  if (overdueDays < 1) return "none";

  let canChase = lastChasedAt === null;
  if (lastChasedAt !== null) {
    const last = Date.parse(lastChasedAt);
    if (!Number.isFinite(last)) throw new Error("Last delivery chase time is invalid.");
    canChase = now.getTime() - last >= DAY_MS;
  }
  if (chaseCount < 2) return canChase ? "chase" : "none";
  return canChase ? "decision" : "none";
}
