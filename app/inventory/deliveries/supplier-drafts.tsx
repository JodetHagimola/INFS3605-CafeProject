import { listSupplierDrafts } from "@/lib/inventory-deliveries/followups";
import styles from "./page.module.css";

export async function SupplierDrafts() {
  let drafts;
  try { drafts = await listSupplierDrafts(); }
  catch { return <p role="status">Supplier drafts could not be loaded. Refresh to try again.</p>; }
  return <section id="supplier-drafts" className={styles.section} aria-label="Supplier email drafts">
    <h2>Supplier email drafts</h2>
    {!drafts.length && <p>No final delivery shortages to follow up.</p>}
    {drafts.map(draft => <details key={draft.receiptId} className={styles.card}>
      <summary>Review supplier email · {draft.subject}</summary>
      <p>{draft.source} · <a href="/automation#mailbox">Check sensor email status</a></p>
      <label>Email for review<textarea readOnly rows={9} style={{ width: "100%" }}
        value={`Subject: ${draft.subject}\n\n${draft.body}`} /></label>
    </details>)}
  </section>;
}
