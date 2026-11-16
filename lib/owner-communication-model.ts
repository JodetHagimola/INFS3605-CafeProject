export type TimeWindow = { start: string; end: string };
export type CafeDayPhase = "pre_open" | "operating" | "wrap_up";

type SydneyClock = { date: string; minutes: number };

function sydneyClock(now: Date): SydneyClock {
  if (!Number.isFinite(now.getTime())) throw new Error("The café clock time is invalid.");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutes: Number(values.hour) * 60 + Number(values.minute),
  };
}

function parseTime(value: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?$/.exec(value);
  if (!match) throw new Error("Café hours must use 24-hour HH:MM time.");
  return Number(match[1]) * 60 + Number(match[2]);
}

export function cafeDayPhase(now: Date, openTime: string, closeTime: string): CafeDayPhase {
  const { minutes } = sydneyClock(now);
  const open = parseTime(openTime);
  const close = parseTime(closeTime);
  if (close <= open) throw new Error("Café closing time must be later than opening time.");
  if (minutes < open) return "pre_open";
  if (minutes >= close) return "wrap_up";
  return "operating";
}

export function isSydneyRushTime(now: Date, windows: unknown): boolean {
  const { minutes } = sydneyClock(now);
  if (!Array.isArray(windows)) return false;
  return windows.some((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const window = value as Record<string, unknown>;
    if (typeof window.start !== "string" || typeof window.end !== "string") return false;
    try {
      const start = parseTime(window.start);
      const end = parseTime(window.end);
      return end > start && minutes >= start && minutes < end;
    } catch {
      return false;
    }
  });
}

export function nextQuietTime(now: Date, windows: unknown): Date {
  const { date, minutes } = sydneyClock(now);
  if (!Array.isArray(windows)) return now;
  const endTimes = windows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const window = value as Record<string, unknown>;
    if (typeof window.start !== "string" || typeof window.end !== "string") return [];
    try {
      const start = parseTime(window.start);
      const end = parseTime(window.end);
      return end > start && minutes >= start && minutes < end ? [end] : [];
    } catch {
      return [];
    }
  });
  if (!endTimes.length) return now;

  const [year, month, day] = date.split("-").map(Number);
  const end = Math.min(...endTimes);
  const localTarget = Date.UTC(year, month - 1, day, Math.floor(end / 60), end % 60);
  let candidate = localTarget;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const observed = Date.UTC(
      Number(values.year), Number(values.month) - 1, Number(values.day),
      Number(values.hour), Number(values.minute), Number(values.second),
    );
    candidate += localTarget - observed;
  }
  return new Date(candidate);
}

export function digestSlot(
  now: Date,
  openTime: string,
  closeTime: string,
): "pre_open" | "wrap_up" | null {
  const { minutes } = sydneyClock(now);
  const open = parseTime(openTime);
  const close = parseTime(closeTime);
  if (minutes >= open - 15 && minutes < open) return "pre_open";
  if (minutes >= close && minutes < close + 30) return "wrap_up";
  return null;
}

export function sydneyDate(now: Date): string {
  return sydneyClock(now).date;
}

export function formatSydneyDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function sydneyDayBounds(date: string): { start: string; end: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)
    || new Date(`${date}T00:00:00.000Z`).toISOString().slice(0, 10) !== date) {
    throw new Error("The requested café date is invalid.");
  }
  function localMidnightToUtc(day: string): Date {
    const [year, month, dayOfMonth] = day.split("-").map(Number);
    const target = Date.UTC(year, month - 1, dayOfMonth);
    let candidate = target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Australia/Sydney",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).formatToParts(new Date(candidate));
      const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
      const observed = Date.UTC(
        Number(values.year), Number(values.month) - 1, Number(values.day),
        Number(values.hour), Number(values.minute), Number(values.second),
      );
      candidate += target - observed;
    }
    return new Date(candidate);
  }
  const [year, month, dayOfMonth] = date.split("-").map(Number);
  const nextDate = new Date(Date.UTC(year, month - 1, dayOfMonth + 1)).toISOString().slice(0, 10);
  return {
    start: localMidnightToUtc(date).toISOString(),
    end: localMidnightToUtc(nextDate).toISOString(),
  };
}
