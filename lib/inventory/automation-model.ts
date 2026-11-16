const MAX_STOCK = 1_000_000_000;
const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

export function calculateAutomaticMinimum(avgDailyUsage: number, leadTimeDays: number): number | null {
  if (!Number.isFinite(avgDailyUsage) || avgDailyUsage <= 0
    || !Number.isInteger(leadTimeDays) || leadTimeDays < 0 || leadTimeDays > 365) return null;
  const minimum = Math.ceil(avgDailyUsage * (leadTimeDays + 1) * 1.1);
  return Number.isSafeInteger(minimum) && minimum <= MAX_STOCK ? minimum : null;
}

export function isStockCountDue(lastCountedAt: string | null, now: number, highUse = false): boolean {
  if (highUse) return true;
  const lastCounted = lastCountedAt ? Date.parse(lastCountedAt) : NaN;
  return !Number.isFinite(lastCounted)
    || lastCounted > now + 5 * 60 * 1000
    || now - lastCounted > SEVEN_DAYS;
}
