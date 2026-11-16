export type SaleIntent = { id: string; product: string; quantity: number };
export type SaleSource = "manual" | "pos" | "simulated" | "chat";
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

export function parseSaleReceipt(value: unknown, expectedId: string): SaleReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Record<string, unknown>;
  if (typeof receipt.sale_id !== "string" || receipt.sale_id.toLowerCase() !== expectedId.toLowerCase()
    || typeof receipt.product_name !== "string"
    || typeof receipt.quantity !== "number" || !Number.isInteger(receipt.quantity)
    || typeof receipt.replayed !== "boolean" || !Array.isArray(receipt.changes) || receipt.changes.length === 0) return null;
  const changes: SaleReceipt["changes"] = [];
  for (const value of receipt.changes) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const change = value as Record<string, unknown>;
    if (typeof change.ingredient_id !== "string" || typeof change.name !== "string"
      || typeof change.unit !== "string" || typeof change.amount !== "string"
      || typeof change.before !== "string" || typeof change.after !== "string") return null;
    changes.push({
      ingredient_id: change.ingredient_id,
      name: change.name,
      unit: change.unit,
      amount: change.amount,
      before: change.before,
      after: change.after,
    });
  }
  return {
    sale_id: receipt.sale_id,
    product_name: receipt.product_name,
    quantity: receipt.quantity,
    replayed: receipt.replayed,
    changes,
  };
}

export function displayAmount(value: number | string): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(6).replace(/\.?0+$/, "") || "0" : "—";
}

export function displaySaleTime(value: string): string {
  const d = new Date(value);
  return Number.isFinite(d.getTime())
    ? new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(d)
    : "—";
}
