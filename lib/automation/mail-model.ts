export function isEmail(value: string): boolean {
  return /^[^\s,;<>@]+@[^\s,;<>@]+\.[^\s,;<>@]+$/.test(value);
}

export function isSupplierAddress(recipient: string, contacts: unknown[]): boolean {
  const normalized = recipient.trim().toLowerCase();
  return contacts.some((contact) =>
    typeof contact === "string" && contact.trim().toLowerCase() === normalized);
}

export function testMailRecipient(channel: string, configuredTo?: string): string {
  if (channel !== "inbox" && channel !== "resend") throw new Error("Invalid test mail mode.");
  const recipient = configuredTo?.trim();
  if (recipient && isEmail(recipient)) return recipient;
  if (channel === "resend") throw new Error("A valid test mailbox address is required.");
  return "demo-inbox@example.invalid";
}

export function factText(facts: Record<string, unknown>, key: string): string {
  const value = facts[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`Mail facts are missing ${key}.`);
  return value.trim();
}

function packDescription(label: string | null, packs: number): string {
  if (!label) return `${packs} pack(s)`;
  const lastWord = label.split(/\s+/).at(-1) ?? "";
  if (!/^[A-Za-z]+$/.test(lastWord)
    || ["ml", "g", "kg", "l", "litre", "litres", "pcs"].includes(lastWord.toLowerCase())) {
    return `${packs} pack(s)`;
  }
  const plural = lastWord.endsWith("s") ? lastWord : `${lastWord}s`;
  return `${packs} ${packs === 1 ? lastWord : plural}`;
}

export function formatOrderLine(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("An order email line is invalid.");
  }
  const line = value as Record<string, unknown>;
  const ingredient = factText(line, "ingredient");
  const unit = factText(line, "unit");
  const packLabel = typeof line.packLabel === "string" && line.packLabel.trim()
    ? line.packLabel.trim()
    : null;
  const quantity = Number(line.quantity);
  const packs = Number(line.packs);
  const price = Number(line.unitPrice);
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isInteger(packs) || packs <= 0
    || !Number.isFinite(price) || price < 0) {
    throw new Error("An order email line contains invalid quantities or prices.");
  }
  const normalized = unit.toLowerCase();
  const divisor = normalized === "ml" ? 1000 : normalized === "g" ? 1000 : 1;
  const displayUnit = normalized === "ml" ? "L" : normalized === "g" ? "kg" : unit;
  const displayedQuantity = quantity / divisor;
  const displayedPrice = price * divisor;
  const expectedDate = factText(line, "expectedDate");
  return `${ingredient}: ${packDescription(packLabel, packs)} (${displayedQuantity} ${displayUnit}) at $${displayedPrice.toFixed(2)} per ${displayUnit}; expected ${expectedDate}.`;
}
