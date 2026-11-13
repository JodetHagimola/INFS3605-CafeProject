import "server-only";
import { generateText, Output } from "ai";
import { getGeminiModel } from "@/lib/agent/model";
import { inventoryClient } from "@/lib/inventory/server";
import { supplierDraft, type ShortageRow } from "./shortage-email";

export async function listSupplierDrafts() {
  const { data, error } = await inventoryClient().from("delivery_shortage_drafts")
    .select("receipt_id,facts,approach").order("created_at", { ascending: false }).order("receipt_id").limit(20);
  if (error) throw new Error("Supplier drafts could not be loaded.");
  return (data as ShortageRow[]).map(supplierDraft);
}

export async function tailorSupplierDraft(receiptId: string) {
  const db = inventoryClient();
  const { data, error } = await db.from("delivery_shortage_drafts").select("receipt_id,facts,approach")
    .eq("receipt_id", receiptId).single<ShortageRow>();
  if (error || !data) throw new Error("Draft could not be read.");
  if (data.approach || !process.env.GOOGLE_GENERATIVE_AI_API_KEY) return;
  const { stockAfter, minimum, missing, ordered } = data.facts;
  const result = await generateText({
    model: getGeminiModel(),
    output: Output.choice({ options: ["replacement_eta", "dispatch_check"] as const }),
    instructions: "Choose the most useful next question for a cafe owner reviewing a confirmed short shipment. Ask about replacement timing when current stock is tight relative to its minimum. Otherwise ask the supplier to reconcile its dispatch record. A missing minimum means urgency is unknown. All quantities use the same unit.",
    prompt: JSON.stringify({ stockAfter, minimum, missing, ordered }),
    maxRetries: 0, abortSignal: AbortSignal.timeout(3500),
  });
  const { error: saveError } = await db.from("delivery_shortage_drafts").update({ approach: result.output })
    .eq("receipt_id", receiptId).is("approach", null);
  if (saveError) throw new Error("Draft approach could not be saved.");
}
