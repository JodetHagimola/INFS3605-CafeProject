const UNIT_DEFINITIONS: Record<string, { dimension: string; factor: number }> = {
  l: { dimension: "volume", factor: 1000 },
  liter: { dimension: "volume", factor: 1000 },
  liters: { dimension: "volume", factor: 1000 },
  litre: { dimension: "volume", factor: 1000 },
  litres: { dimension: "volume", factor: 1000 },
  ml: { dimension: "volume", factor: 1 },
  milliliter: { dimension: "volume", factor: 1 },
  milliliters: { dimension: "volume", factor: 1 },
  millilitre: { dimension: "volume", factor: 1 },
  millilitres: { dimension: "volume", factor: 1 },
  kg: { dimension: "mass", factor: 1000 },
  kilogram: { dimension: "mass", factor: 1000 },
  kilograms: { dimension: "mass", factor: 1000 },
  g: { dimension: "mass", factor: 1 },
  gram: { dimension: "mass", factor: 1 },
  grams: { dimension: "mass", factor: 1 },
  mg: { dimension: "mass", factor: 0.001 },
  milligram: { dimension: "mass", factor: 0.001 },
  milligrams: { dimension: "mass", factor: 0.001 },
  ea: { dimension: "count", factor: 1 },
  each: { dimension: "count", factor: 1 },
  unit: { dimension: "count", factor: 1 },
  units: { dimension: "count", factor: 1 },
  item: { dimension: "count", factor: 1 },
  items: { dimension: "count", factor: 1 },
  piece: { dimension: "count", factor: 1 },
  pieces: { dimension: "count", factor: 1 },
};

function normalizedUnit(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

export function convertStockQuantity(quantity: number, fromUnit: string, toUnit: string): number {
  const sourceUnit = normalizedUnit(fromUnit);
  const targetUnit = normalizedUnit(toUnit);
  if (!sourceUnit || !targetUnit) throw new Error("A stock unit is required.");
  if (sourceUnit === targetUnit) return quantity;

  const source = UNIT_DEFINITIONS[sourceUnit];
  const target = UNIT_DEFINITIONS[targetUnit];
  if (!source || !target || source.dimension !== target.dimension) {
    throw new Error(`Cannot safely convert ${fromUnit} to ${toUnit}.`);
  }

  const converted = Math.round((quantity * source.factor / target.factor) * 1_000_000) / 1_000_000;
  if (!Number.isFinite(converted) || converted <= 0 || converted > 1_000_000_000) {
    throw new Error("The converted stock quantity is outside the supported range.");
  }
  return converted;
}
