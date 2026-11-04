import { z } from "zod";

const briefActionSchema = z.object({
  label: z.enum(["Approve", "Edit", "Confirm", "Dismiss"]),
  approvalId: z.string().uuid().optional(),
}).strict();

const briefOutputActionSchema = z.object({
  label: z.enum(["Approve", "Edit", "Confirm", "Dismiss"]),
  approvalId: z.string().nullable(),
});

export const dailyBriefOutputSchema = z.object({
  greeting: z.string(),
  statusLine: z.string(),
  items: z.array(z.object({
    title: z.string(),
    why: z.string(),
    actionTaken: z.string(),
    primaryAction: briefOutputActionSchema,
    secondaryAction: briefOutputActionSchema.nullable(),
  })),
  allClear: z.string(),
  details: z.object({
    lowStock: z.array(z.object({
      ingredientId: z.string(),
      ingredient: z.string(),
      quantity: z.number().nullable(),
      unit: z.string(),
      status: z.string(),
    })),
    forecasts: z.array(z.object({
      date: z.string(),
      product: z.string(),
      low: z.number(),
      expected: z.number(),
      high: z.number(),
    })),
    deliveries: z.array(z.object({
      deliveryId: z.string(),
      ingredient: z.string(),
      orderedQuantity: z.number(),
      receivedQuantity: z.number(),
      expectedDate: z.string(),
      status: z.string(),
      flag: z.string().nullable(),
    })),
    supplierComparison: z.array(z.object({
      ingredient: z.string(),
      supplier: z.string(),
      price: z.number(),
      deliveryTime: z.string(),
      minimumOrder: z.number(),
    })),
    assumptions: z.array(z.string()),
    dataWarnings: z.array(z.string()),
  }),
});

export const dailyBriefSchema = z.object({
  greeting: z.string().trim().min(1).max(160),
  statusLine: z.string().trim().min(1).max(240),
  items: z.array(z.object({
    id: z.string().trim().min(1).max(120),
    title: z.string().trim().min(1).max(180),
    why: z.string().trim().min(1).max(240),
    actionTaken: z.string().trim().min(1).max(240),
    primaryAction: briefActionSchema,
    secondaryAction: briefActionSchema.optional(),
  }).strict()).max(3),
  allClear: z.string().trim().min(1).max(500),
  details: z.object({
    lowStock: z.array(z.object({
      ingredientId: z.string().max(100),
      ingredient: z.string().max(120),
      quantity: z.number().finite().nonnegative().nullable(),
      unit: z.string().max(40),
      status: z.string().max(80),
    }).strict()).max(100),
    forecasts: z.array(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      product: z.string().max(120),
      low: z.number().int().nonnegative(),
      expected: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
    }).strict()).max(300),
    deliveries: z.array(z.object({
      deliveryId: z.string().max(100),
      ingredient: z.string().max(120),
      orderedQuantity: z.number().finite().nonnegative(),
      receivedQuantity: z.number().finite().nonnegative(),
      expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      status: z.string().max(80),
      flag: z.string().max(240).nullable(),
    }).strict()).max(100),
    supplierComparison: z.array(z.object({
      ingredient: z.string().max(120),
      supplier: z.string().max(120),
      price: z.number().finite().nonnegative(),
      deliveryTime: z.string().max(120),
      minimumOrder: z.number().finite().nonnegative(),
    }).strict()).max(100),
    assumptions: z.array(z.string().trim().min(1).max(300)).max(20),
    dataWarnings: z.array(z.string().trim().min(1).max(300)).max(20),
  }).strict(),
}).strict();

export type DailyBrief = z.infer<typeof dailyBriefSchema>;

type DailyBriefOutput = z.infer<typeof dailyBriefOutputSchema>;

export function normalizeDailyBriefOutput(
  output: DailyBriefOutput,
  createdApprovalIds: ReadonlySet<string>,
  autoApprovedIds: ReadonlySet<string>,
): DailyBrief {
  const normalizeAction = (action: DailyBriefOutput["items"][number]["primaryAction"]) => {
    const approvalId = action.approvalId && createdApprovalIds.has(action.approvalId)
      ? action.approvalId
      : undefined;
    if (approvalId && autoApprovedIds.has(approvalId)) {
      return { label: "Confirm" as const, approvalId };
    }
    if ((action.label === "Approve" || action.label === "Dismiss") && !approvalId) {
      return { label: "Edit" as const };
    }
    return approvalId ? { label: action.label, approvalId } : { label: action.label };
  };

  return dailyBriefSchema.parse({
    greeting: output.greeting,
    statusLine: output.statusLine,
    items: output.items.map((item, index) => ({
      id: `brief-item-${index + 1}`,
      title: item.title,
      why: item.why,
      actionTaken: item.actionTaken,
      primaryAction: normalizeAction(item.primaryAction),
      ...(item.secondaryAction ? { secondaryAction: normalizeAction(item.secondaryAction) } : {}),
    })),
    allClear: output.allClear,
    details: output.details,
  });
}
