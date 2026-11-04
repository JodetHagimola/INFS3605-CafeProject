import { z } from "zod";

export const dailyBriefOutputSchema = z.object({
  greeting: z.string().trim().min(1).max(100),
}).strict();

const trafficSchema = z.object({
  label: z.enum(["busy", "quiet", "typical"]).nullable(),
  headline: z.string().trim().min(1).max(240),
  expected_drinks: z.number().int().nonnegative().nullable(),
  low: z.number().int().nonnegative().nullable(),
  high: z.number().int().nonnegative().nullable(),
  note: z.string().trim().min(1).max(240).optional(),
}).strict();

const stockItemSchema = z.object({
  ingredient_id: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(120),
  headline: z.string().trim().min(1).max(180),
  why: z.string().trim().min(1).max(300),
  suggested_order: z.object({
    quantity: z.number().finite().nonnegative().nullable(),
    unit: z.string().trim().min(1).max(12),
    supplier: z.string().trim().min(1).max(120).nullable(),
    estimated_cost: z.number().finite().nonnegative().nullable(),
  }).strict(),
  approve_action_id: z.string().uuid().nullable(),
}).strict();

export const dailyBriefSchema = z.object({
  greeting: z.string().trim().min(1).max(160),
  status_line: z.string().trim().min(1).max(240),
  traffic: trafficSchema,
  stock_items: z.array(stockItemSchema).max(3),
  all_clear: z.string().trim().min(1).max(500),
  data_warnings: z.array(z.string().trim().min(1).max(300)).max(20),
}).strict();

export type DailyBrief = z.infer<typeof dailyBriefSchema>;
export type DailyBriefStockItem = DailyBrief["stock_items"][number];
