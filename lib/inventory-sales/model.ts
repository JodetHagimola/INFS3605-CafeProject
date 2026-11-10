export type SaleIntent = { id: string; product: string; quantity: number };
export type RecipePart = { ingredientId: string; name: string; unit: string; perDrink: number };
export type SaleProduct = { name: string; parts: RecipePart[] };
export type SaleReceipt = {
  sale_id: string; product_name: string; quantity: number; replayed: boolean;
  changes: { ingredient_id: string; name: string; unit: string; amount: string; before: string; after: string }[];
};
export type SaleResult = {
  status: "idle" | "success" | "error" | "uncertain";
  message: string;
  receipt?: SaleReceipt;
};

export function parseSaleIntent(value: unknown): SaleIntent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.id)
    || typeof v.product !== "string" || v.product.trim().length === 0 || v.product.length > 120
    || typeof v.quantity !== "number" || !Number.isInteger(v.quantity) || v.quantity < 1 || v.quantity > 1000) return null;
  return { id: v.id, product: v.product, quantity: v.quantity };
}

export function displayAmount(value: number | string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6).replace(/\.?0+$/, "") || "0" : "—";
}

// UTC text avoids locale-dependent server/browser hydration differences.
export function displaySaleTime(value: string): string {
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 19).replace("T", " ") + " UTC" : "—";
}
