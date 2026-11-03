import "server-only";

import { getInventory } from "@/lib/inventory/server";
import { getDeliveryChecks } from "./tools/check-deliveries";
import { getLatestDraft, type DraftOrder } from "./server";

export async function getTodayBrief(): Promise<{
  lowStock: Awaited<ReturnType<typeof getInventory>>["items"];
  inventoryError: string | null;
  deliveries: Awaited<ReturnType<typeof getDeliveryChecks>>;
  deliveryError: string | null;
  draft: DraftOrder | null;
  draftError: string | null;
}> {
  const [inventoryResult, draftResult, deliveryResult] = await Promise.all([
    getInventory(),
    getLatestDraft(),
    getDeliveryChecks().then(
      (deliveries) => ({ deliveries, error: null }),
      (error: unknown) => ({
        deliveries: [],
        error: error instanceof Error ? error.message : "Delivery data could not be loaded.",
      }),
    ),
  ]);
  const attentionStatuses = new Set([
    "Low stock",
    "Out of stock",
    "No stock record",
    "Check data",
    "Threshold not set",
  ]);
  return {
    lowStock: inventoryResult.items.filter((item) => attentionStatuses.has(item.status)),
    inventoryError: inventoryResult.error,
    deliveries: deliveryResult.deliveries,
    deliveryError: deliveryResult.error,
    draft: draftResult.draft,
    draftError: draftResult.error,
  };
}
