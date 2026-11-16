import { SiteNav } from "../../site-nav";
import { hasAgentSession } from "@/lib/agent/auth";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { formatSydneyDateTime } from "@/lib/owner-communication-model";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import { getDeliveryData } from "@/lib/inventory-deliveries/server";
import { SensorForm } from "../../automation/forms";
import { SupplierDrafts } from "./supplier-drafts";
import { ReceiveForm, RegisterForm } from "./forms";
import styles from "./page.module.css";
export const metadata: Metadata = { title: "Receive deliveries | Brewlytics" };

export default async function DeliveriesPage() {
  await connection();
  if (!(await hasAgentSession())) redirect("/");
  const result = await getDeliveryData();
  const canWrite = inventoryWritesEnabled();
  const attentionDeliveries = result.deliveries.filter(item => item.attention.length > 0);
  const routineDeliveries = result.deliveries.filter(item => item.attention.length === 0);
  return <main className="page-shell">
    <SiteNav current="deliveries" />
    <section className={styles.intro}><p className="eyebrow">DAILY OPERATIONS</p><h1>Receive deliveries</h1>
      <p>Check what arrived. Confirm the actual quantity to add it to stock and reduce what is still expected.</p>
      <p className={styles.muted}>Use the displayed stock unit: 5 L of milk = 5,000 mL; 1 kg of beans = 1,000 g. Record each arrival once.</p>
      {!canWrite && <p className="notice">Stock changes are disabled by server policy.</p>}
    </section>
    {result.error ? <p role="alert" className="notice">{result.error}</p> : <>
      <SensorForm deliveries={result.deliveries} canWrite={canWrite} />
      {result.notices.length > 0 && <section className={styles.section} aria-labelledby="delivery-notices">
        <h2 id="delivery-notices">Delivery decisions for the owner <span className={styles.count}>{result.notices.length}</span></h2>
        <div className={styles.grid}>{result.notices.map(notice => <article key={notice.id} className={styles.card}>
          <p className={styles.kicker}>{notice.severity}</p><h3>{notice.title}</h3><p>{notice.body}</p>
        </article>)}</div>
      </section>}
      <section className={styles.section} aria-labelledby="pending"><h2 id="pending">Delivery exceptions <span className={styles.count}>{attentionDeliveries.length}</span></h2>
        <p className={styles.muted}>Overdue, partial, or arrival-window issues need attention. Record quantities only when goods physically arrive.</p>
        {!attentionDeliveries.length && <p className={styles.empty}>No delivery exceptions.</p>}
        <div className={styles.grid}>{attentionDeliveries.map(item => <article key={item.id} className={styles.card}>
          <p className={styles.kicker}>DELIVERY #{item.id}{item.demo ? " · DEMO DATA" : ""}</p><h3>{item.name}</h3>
          <p className={styles.quantity}>{item.outstanding} <span>{item.unit} still expected</span></p>
          <ul>{item.attention.map(message => <li key={message}>{message}</li>)}</ul>
          <dl><dt>Ordered</dt><dd>{item.ordered} {item.unit}</dd><dt>Expected</dt><dd>{item.expected}</dd><dt>Supplier</dt><dd>{item.supplier}</dd><dt>Reference</dt><dd>{item.reference}</dd>
            <dt>Supplier window</dt><dd>{item.windowStart && item.windowEnd ? `${item.windowStart.slice(0, 5)}–${item.windowEnd.slice(0, 5)} Sydney time` : "Not configured"}</dd>
            {item.arrivalResult && <><dt>Arrival check</dt><dd>{item.arrivalResult}{item.arrivalCheckedAt ? ` · ${new Date(item.arrivalCheckedAt).toLocaleString("en-AU", { timeZone: "Australia/Sydney" })} Sydney time` : ""}</dd></>}
          </dl>
          {item.demo && <p className={styles.muted}>Test delivery.</p>}
          <details><summary>Receive manually</summary>
            <ReceiveForm id={item.id} remaining={item.outstanding} unit={item.unit} requestId={randomUUID()} canWrite={canWrite} />
          </details>
        </article>)}</div>
      </section>
      <details className={styles.section}>
        <summary><strong>Routine incoming deliveries ({routineDeliveries.length})</strong></summary>
        <p className={styles.muted}>Partial deliveries stay open until the remaining quantity arrives. Refresh after recording a receipt to see the latest balance.</p>
        {!routineDeliveries.length && <p className={styles.empty}>No routine incoming deliveries.</p>}
        <div className={styles.grid}>{routineDeliveries.map(item => <article key={item.id} className={styles.card}>
          <p className={styles.kicker}>DELIVERY #{item.id}{item.demo ? " · DEMO DATA" : ""}</p><h3>{item.name}</h3>
          <p className={styles.quantity}>{item.outstanding} <span>{item.unit} still expected</span></p>
          <dl><dt>Ordered</dt><dd>{item.ordered} {item.unit}</dd><dt>Expected</dt><dd>{item.expected}</dd><dt>Supplier</dt><dd>{item.supplier}</dd><dt>Reference</dt><dd>{item.reference}</dd></dl>
          {item.demo && <p className={styles.muted}>Test delivery.</p>}
          <details><summary>Receive manually</summary>
            <ReceiveForm id={item.id} remaining={item.outstanding} unit={item.unit} requestId={randomUUID()} canWrite={canWrite} />
          </details>
        </article>)}</div>
      </details>
      {!result.deliveries.length && <p className={styles.empty}>No outstanding deliveries. Register a placed order below.</p>}
      <section className={styles.section} aria-labelledby="approved"><h2 id="approved">Register a placed order</h2>
        <p className={styles.muted}>Approved AI Forecast drafts appear below. After placing the order with the suppliers, register it here. This step does not send an order or add stock. All lines use the arrival date entered.</p>
        <p className={styles.muted}>Approvals on Today are separate decisions and do not create expected deliveries here.</p>
        {!result.orders.length && <p className={styles.empty}>No unregistered approved drafts. Review and approve a draft on <a href="/automated-ordering">AI Forecast</a> first.</p>}
        {result.orders.map(order => <details key={order.id} className={styles.card}><summary>Approved order {order.id.slice(0, 8)} · {order.lines.length} ingredient(s)</summary>
          <ul>{order.lines.map((line, index) => <li key={index}>{line.name}: {line.amount} {line.unit} · {line.supplier}</li>)}</ul>
          <RegisterForm draftId={order.id} canWrite={canWrite} />
        </details>)}
      </section>
      <SupplierDrafts />
      <section className={styles.section} aria-labelledby="history"><h2 id="history">Recent receipts</h2><p className={styles.muted}>Latest 20 receipts. Stock balances are snapshots at receipt time. Times are shown in Sydney.</p>
        {!result.receipts.length ? <p className={styles.empty}>No receipts recorded yet.</p> : <div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Ingredient</th><th>Received</th><th>Stock after</th><th>Unreceived at receipt</th><th>Recorded (Sydney)</th></tr></thead><tbody>
          {result.receipts.map(row => <tr key={row.id}><td><code title={row.id}>{row.id.slice(0, 8)}</code></td><td>{row.name}</td><td>+{row.amount} {row.unit}</td><td>{row.after} {row.unit}</td><td>{row.remaining} {row.unit}</td><td><time dateTime={row.created}>{formatSydneyDateTime(row.created)}</time></td></tr>)}
        </tbody></table></div>}
      </section><p><a href="/inventory">View updated inventory →</a></p>
    </>}
  </main>;
}
