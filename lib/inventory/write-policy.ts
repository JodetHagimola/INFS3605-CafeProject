export function inventoryWritesEnabled(
  environment = process.env.NODE_ENV,
  flag = process.env.INVENTORY_WRITES_ENABLED,
): boolean {
  return environment !== "production" || flag === "true";
}
