export type StockStatus = "In stock" | "Low stock" | "Out of stock" | "Threshold not set" | "No stock record" | "Check data";

export type InventoryItem = {
  id: string;
  name: string;
  unit: string;
  quantity: number | null;
  minimum: number | null;
  updated: string | null;
  lastCounted: string | null;
  countDue: boolean;
  autoThreshold: boolean;
  status: StockStatus;
};

export function numeric(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function stockStatus(hasRecord: boolean, quantity: number | null, minimum: number | null): StockStatus {
  if (!hasRecord) return "No stock record";
  if (quantity === null || quantity < 0 || (minimum !== null && minimum < 0)) return "Check data";
  if (quantity === 0) return "Out of stock";
  if (minimum === null) return "Threshold not set";
  return quantity <= minimum ? "Low stock" : "In stock";
}

export function movementAmount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return null;
  const n = Number(value);
  return n > 0 && n <= 1000000000 ? n : null;
}

export function countedAmount(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1000000000 ? n : null;
}
