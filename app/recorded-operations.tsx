import { getRecordedOperations } from "@/lib/inventory-sales/operations";

export async function RecordedOperations({ date }: { date: string }) {
  try {
    const summary = await getRecordedOperations(date);
    return <section aria-labelledby="recorded-operations-title" style={{ margin: "24px auto 48px", maxWidth: 760 }}>
      <details>
        <summary id="recorded-operations-title" style={{ cursor: "pointer", fontWeight: 600 }}>
          Recorded activity · {summary.drinksRecorded} drinks · {summary.transactionCount} {summary.transactionCount === 1 ? "sale" : "sales"}
        </summary>
        <p>Recorded on {date} (Sydney time). These entries may cover only part of the day.</p>
        {summary.products.length > 0 && <p>{summary.products.map(item => `${item.name}: ${item.quantity}`).join(" · ")}</p>}
        <p><strong>Ingredients used in recorded sales: </strong>{summary.ingredientsUsed.length
          ? summary.ingredientsUsed.map(item => `${item.name} ${item.amount} ${item.unit}`).join(" · ") : "No recorded sales usage."}</p>
        <p><strong>Confirmed deliveries: </strong>{summary.deliveriesReceived.length
          ? summary.deliveriesReceived.map(item => `${item.name} +${item.amount} ${item.unit}`).join(" · ") : "No recorded delivery receipts."}</p>
        <p>Usage comes from each sale’s saved recipe. Waste and manual adjustments are separate.</p>
        <p><a href="/inventory/sales">Record sale</a> · <a href="/inventory/deliveries">Receive deliveries</a></p>
      </details>
    </section>;
  } catch {
    return <p role="status">Recorded sales and receipts are unavailable. Please refresh or ask your team to check the connection.</p>;
  }
}
