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
    : "Could you check the dispatch record and advise how we can resolve the difference?";
  return {
    receiptId: row.receipt_id,
    subject: `Short delivery for ${f.reference} (${f.ingredient})`,
    body: [
      f.supplier ? `Hello ${f.supplier} team,` : "Hello,",
      `We have checked the final delivery for ${f.reference}. We ordered ${f.ordered} ${f.unit} of ${f.ingredient} and received ${f.received} ${f.unit} in total. The order is short by ${f.missing} ${f.unit}.`,
      question, "Thank you."
    ].join("\n\n"),
    source: row.approach ? "Agent-assisted draft" : "Standard draft",
  };
}
