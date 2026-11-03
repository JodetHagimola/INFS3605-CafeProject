import { z } from "zod";
import { approvalItemSchema } from "./approval-schema";
import { draftOrderSchema } from "./draft-schema";

export const inventoryCardItemSchema = z.object({
  id: z.string().min(1).max(100),
  name: z.string().min(1).max(120),
  unit: z.string().min(1).max(40),
  quantity: z.number().finite().nonnegative().nullable(),
  minimum: z.number().finite().nonnegative().nullable(),
  updated: z.string().nullable(),
  status: z.enum([
    "In stock",
    "Low stock",
    "Out of stock",
    "Threshold not set",
    "No stock record",
    "Check data",
  ]),
}).strict();

export const agentMessagePartSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string().max(12000) }).strict(),
  z.object({ type: z.literal("approval_card"), item: approvalItemSchema }).strict(),
  z.object({ type: z.literal("draft_order"), draft: draftOrderSchema }).strict(),
  z.object({
    type: z.literal("stock_table"),
    items: z.array(inventoryCardItemSchema).max(100),
  }).strict(),
]);

export const agentMessageSchema = z.object({
  id: z.string().uuid(),
  role: z.enum(["owner", "agent"]),
  content: z.string().max(12000),
  parts: z.array(agentMessagePartSchema).max(10),
  createdAt: z.string().min(1),
}).strict();

export type AgentMessage = z.infer<typeof agentMessageSchema>;
export type AgentMessagePart = z.infer<typeof agentMessagePartSchema>;
