import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type PosSaleItem = { product_name: string; quantity: number };

export function normalizePosItems(items: unknown): PosSaleItem[] | null {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) return null;
  const grouped = new Map<string, number>();
  for (const item of items) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.product_name !== "string" || !row.product_name.trim()
      || row.product_name.trim().length > 120 || typeof row.quantity !== "number"
      || !Number.isInteger(row.quantity) || row.quantity < 1 || row.quantity > 1000) return null;
    const product = row.product_name.trim();
    const quantity = (grouped.get(product) ?? 0) + row.quantity;
    if (quantity > 1000) return null;
    grouped.set(product, quantity);
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([product_name, quantity]) => ({ product_name, quantity }));
}

export function verifyPosSignature(rawBody: Uint8Array, signature: string | null, secret: string): boolean {
  const match = signature ? /^sha256=([a-f0-9]{64})$/i.exec(signature) : null;
  if (!match || !secret) return false;
  const supplied = Buffer.from(match[1], "hex");
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function hashPosPayload(rawBody: Uint8Array): string {
  return createHash("sha256").update(rawBody).digest("hex");
}
