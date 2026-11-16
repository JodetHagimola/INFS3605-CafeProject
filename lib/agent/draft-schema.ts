import { z } from "zod";

const supplierChoiceSchema = z.object({
  supplier: z.string().min(1).max(120),
  price: z.number().finite().nonnegative(),
  deliveryTime: z.string().min(1).max(120),
  minimumOrder: z.number().finite().nonnegative(),
}).strict();

export const draftOrderSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["draft", "approved"]),
  forecastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdAt: z.string().min(1),
  forecast: z.object({
    forecastDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    isPublicHoliday: z.boolean().nullable(),
    predictedSales: z.record(z.string(), z.number().int().nonnegative()),
    ranges: z.record(z.string(), z.object({
      low: z.number().int().nonnegative(),
      expected: z.number().int().nonnegative(),
      high: z.number().int().nonnegative(),
    }).strict()).optional(),
    assumptions: z.array(z.string()).optional(),
    source: z.string().min(1),
  }).strict(),
  lines: z.array(z.object({
    ingredientId: z.string().min(1).max(100),
    ingredient: z.string().min(1).max(120),
    requiredQuantity: z.number().finite().nonnegative(),
    requiredRange: z.object({
      low: z.number().finite().nonnegative(),
      high: z.number().finite().nonnegative(),
    }).strict().optional(),
    currentStock: z.number().finite().nonnegative(),
    incomingStock: z.number().finite().nonnegative(),
    recommendedOrderQuantity: z.number().finite().nonnegative(),
    expectedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    packCount: z.number().int().positive().optional(),
    packSize: z.number().finite().positive().optional(),
    packLabel: z.string().max(120).nullable().optional(),
    totalCents: z.number().int().nonnegative().optional(),
    unit: z.string().min(1).max(40),
    recommendedSupplier: supplierChoiceSchema,
    alternativeSupplier: supplierChoiceSchema.nullable(),
    reason: z.string().trim().min(1).max(500),
  }).strict()).max(100),
  flags: z.array(z.string().max(500)).max(100),
  dataUsed: z.object({
    recipes: z.array(z.object({
      productName: z.string(),
      ingredientId: z.string(),
      quantityPerDrink: z.number().finite().nonnegative(),
    })),
    inventory: z.array(z.object({
      ingredientId: z.string(),
      quantity: z.number().finite().nonnegative().nullable(),
      lastUpdated: z.string().nullable(),
    })),
    deliveries: z.array(z.object({
      deliveryId: z.string().optional(),
      ingredientId: z.string(),
      quantity: z.number().finite().nonnegative(),
      expectedDate: z.string(),
    })),
    receipts: z.array(z.object({
      deliveryId: z.string(),
      receivedQuantity: z.number().finite().nonnegative(),
      receivedAt: z.string().min(1),
    })).optional(),
    supplierPrices: z.array(z.object({
      supplier: z.string(),
      ingredientId: z.string(),
      price: z.number().finite().nonnegative(),
      deliveryTime: z.string(),
      minimumOrder: z.number().finite().nonnegative(),
      packSize: z.number().finite().positive().optional(),
      packLabel: z.string().max(120).nullable().optional(),
    })),
  }).strict(),
}).strict();

export const draftOrderInsertSchema = draftOrderSchema.omit({
  id: true,
  createdAt: true,
});

export type DraftOrderRecord = z.infer<typeof draftOrderSchema>;
