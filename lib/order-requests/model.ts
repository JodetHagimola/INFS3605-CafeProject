export type OrderRequestItem = {
  name: string;
  quantity: number;
  unit: string;
};

export type OrderRequestStatus = "pending" | "approved" | "rejected";

type ParsedItems =
  | { items: OrderRequestItem[]; error: null }
  | { items: null; error: string };

function formValue(value: FormDataEntryValue | undefined): string {
  return typeof value === "string" ? value : "";
}

export function parseOrderRequestItems(
  names: FormDataEntryValue[],
  quantities: FormDataEntryValue[],
  units: FormDataEntryValue[],
): ParsedItems {
  if (names.length !== quantities.length || names.length !== units.length) {
    return { items: null, error: "Refresh the page and enter the order items again." };
  }

  if (names.length > 20) {
    return { items: null, error: "An order can contain up to 20 items." };
  }

  const items: OrderRequestItem[] = [];

  for (let index = 0; index < names.length; index += 1) {
    const name = formValue(names[index]).trim();
    const quantityText = formValue(quantities[index]).trim();
    const unit = formValue(units[index]).trim();

    if (!name && !quantityText && !unit) continue;
    if (!name || !quantityText || !unit) {
      return { items: null, error: `Complete all fields for item ${index + 1}.` };
    }
    if (name.length > 100 || unit.length > 30) {
      return { items: null, error: `Item ${index + 1} has a name or unit that is too long.` };
    }
    if (!/^\d+(?:\.\d{1,3})?$/.test(quantityText)) {
      return { items: null, error: `Enter a positive quantity with up to 3 decimal places for item ${index + 1}.` };
    }

    const quantity = Number(quantityText);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) {
      return { items: null, error: `Item ${index + 1} quantity must be greater than 0 and no more than 1,000,000.` };
    }

    items.push({ name, quantity, unit });
  }

  if (items.length === 0) {
    return { items: null, error: "Add at least one item to the order." };
  }

  return { items, error: null };
}

export function isOrderRequestStatus(value: unknown): value is OrderRequestStatus {
  return value === "pending" || value === "approved" || value === "rejected";
}
