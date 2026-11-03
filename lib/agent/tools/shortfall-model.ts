export function shortfallAmount(required: number, stock: number, incoming: number): number {
  if ([required, stock, incoming].some((value) => !Number.isFinite(value) || value < 0)) {
    throw new Error("Shortfall inputs must be finite and nonnegative.");
  }
  return Math.max(0, required - stock - incoming);
}
