export type ShortageFacts = {
  reference: string; supplier: string | null; ingredient: string; unit: string;
  ordered: string; received: string; missing: string; stockAfter: string; minimum: string | null;
};
export type FollowupApproach = "replacement_eta" | "dispatch_check";
export type ShortageRow = { receipt_id: string; facts: ShortageFacts; approach: FollowupApproach | null };

export function supplierDraft(row: ShortageRow) {
  const f = row.facts;
  const question = row.approach === "replacement_eta"
    ? "Could you let us know whether the missing quantity can be supplied and when it could arrive?"
    : "Could you confirm whether the remaining quantity is still on its way and when it could arrive?";
  return {
    receiptId: row.receipt_id,
    subject: `Short delivery for ${f.reference} (${f.ingredient})`,
    body: [
      f.supplier ? `Hello ${f.supplier} team,` : "Hello,",
      `We ordered ${f.ordered} ${f.unit} of ${f.ingredient} for ${f.reference} and have received ${f.received} ${f.unit} so far. ${f.missing} ${f.unit} remains outstanding.`,
      question, "Thank you."
    ].join("\n\n"),
    source: row.approach ? "Agent-assisted draft" : "Standard draft",
  };
}
