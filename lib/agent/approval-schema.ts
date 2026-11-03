import { z } from "zod";

export const approvalActionSchema = z.enum([
  "place_or_send_order",
  "contact_supplier",
  "switch_supplier",
  "change_supplier_price",
]);

export const approvalDetailsSchema = z.record(
  z.string().max(80),
  z.union([z.string().max(1000), z.number().finite(), z.boolean(), z.null()]),
).refine((value) => Object.keys(value).length <= 30);

export const approvalRequestDetailsSchema = approvalDetailsSchema
  .refine((value) => Object.keys(value).length <= 28);

export const approvalItemSchema = z.object({
  id: z.string().uuid(),
  action: approvalActionSchema,
  summary: z.string().min(1).max(500),
  details: approvalDetailsSchema,
  status: z.enum(["pending_approval", "approved", "rejected"]),
  createdAt: z.string().min(1),
  reviewedAt: z.string().nullable(),
  reviewerNote: z.string().nullable(),
}).strict();

export type ApprovalItem = z.infer<typeof approvalItemSchema>;
