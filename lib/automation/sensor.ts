import { createHash } from "node:crypto";

export const scans = ["full", "partial", "final_short", "extra"] as const;
export type Scan = typeof scans[number];

// The demo reader emits an observed quantity and a packing-slip final-arrival flag.
// Use integer micro-units to match the receipt ledger's decimal precision.
export function simulateScan(delivery: string, balance: string, unit: string, scenario: Scan) {
  if (!/^\d+(\.\d{1,6})?$/.test(balance)) throw new Error("Unsupported delivery balance.");
  const [whole, fraction = ""] = balance.split(".");
  const remaining = BigInt(whole) * BigInt(1000000) + BigInt(fraction.padEnd(6, "0"));
  const observed = scenario === "full" ? remaining : scenario === "extra" ? remaining + (remaining / BigInt(5) || BigInt(1)) : remaining * BigInt(4) / BigInt(5);
  if (observed <= BigInt(0) || observed > BigInt(1000000000000000)) throw new Error("Choose another reading for this delivery size.");
  const measured = (observed / BigInt(1000000)).toString() + "." + (observed % BigInt(1000000)).toString().padStart(6, "0");
  const key = createHash("sha256").update(JSON.stringify(["demo-scanner-v1",delivery,remaining.toString(),unit,scenario])).digest("hex");
  return { p_event: `${key.slice(0,8)}-${key.slice(8,12)}-5${key.slice(13,16)}-8${key.slice(17,20)}-${key.slice(20,32)}`,
    p_delivery: delivery, p_measured: measured, p_expected: balance, p_unit: unit, p_final: scenario !== "partial" };
}
