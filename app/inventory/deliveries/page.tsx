import type { Metadata } from "next";
import { connection } from "next/server";
import { randomUUID } from "node:crypto";
import { getDeliveryData } from "@/lib/inventory-deliveries/server";
import { ReceiveForm, RegisterForm } from "./forms";
import styles from "./page.module.css";
export const metadata: Metadata = { title: "Receive deliveries | Brewlytics" };

export default async function DeliveriesPage() {
  await connection();
  const result = await getDeliveryData();
  const canWrite = process.env.NODE_ENV === "development";
  return <main className="page-shell">
    <header className="topbar"><a className="wordmark" href="/">Brewlytics</a>
      <nav className="topbar-nav" aria-label="Main navigation"><a href="/inventory">Inventory</a><a href="/inventory/deliveries" aria-current="page">Receive deliveries</a><a href="/automated-ordering">AI Forecast</a></nav>
    </header>
    <section className={styles.intro}><p className="eyebrow">DAILY OPERATIONS</p><h1>Receive deliveries</h1>
      <p>Check what arrived. Confirm the actual quantity to add it to stock and reduce what is still expected.</p>
      <p className={styles.muted}>Use the displayed stock unit: 5 L of milk = 5,000 mL; 1 kg of beans = 1,000 g. Record each arrival once.</p>
      {!canWrite && <p className="notice">Read-only view. Receipt entry is available in the private development demo.</p>}
    </section>
    {result.error ? <p role="alert" className="notice">{result.error}</p> : <>
      <section className={styles.section} aria-labelledby="pending"><h2 id="pending">Expected deliveries <span className={styles.count}>{result.deliveries.length}</span></h2>
        <p className={styles.muted}>Partial deliveries stay here until the remaining quantity arrives. Refresh after a receipt to see the latest balance.</p>
        {!result.deliveries.length && <p className={styles.empty}>No outstanding deliveries. Register a placed order below.</p>}
        <div className={styles.grid}>{result.deliveries.map(item => <article key={item.id} className={styles.card}>
          <p className={styles.kicker}>DELIVERY #{item.id}{item.demo ? " · DEMO DATA" : ""}</p><h3>{item.name}</h3>
          <p className={styles.quantity}>{item.outstanding} <span>{item.unit} still expected</span></p>
          <dl><dt>Ordered</dt><dd>{item.ordered} {item.unit}</dd><dt>Expected</dt><dd>{item.expected}</dd><dt>Supplier</dt><dd>{item.supplier}</dd><dt>Reference</dt><dd>{item.reference}</dd></dl>
          {item.demo && <p className={styles.muted}>Illustrative delivery from the earlier demo setup.</p>}
          <ReceiveForm id={item.id} remaining={item.outstanding} unit={item.unit} requestId={randomUUID()} canWrite={canWrite} />
        </article>)}</div>
      </section>
      <section className={styles.section} aria-labelledby="approved"><h2 id="approved">Register a placed order</h2>
        <p className={styles.muted}>Approved AI drafts appear below. After placing the order with the suppliers, register it here. This step does not send an order or add stock. All lines use the arrival date entered.</p>
        {!result.orders.length && <p className={styles.empty}>No unregistered approved drafts. Review and approve a draft on <a href="/automated-ordering">AI Forecast</a> first.</p>}
        {result.orders.map(order => <details key={order.id} className={styles.card}><summary>Approved order {order.id.slice(0, 8)} · {order.lines.length} ingredient(s)</summary>
          <ul>{order.lines.map((line, index) => <li key={index}>{line.name}: {line.amount} {line.unit} · {line.supplier}</li>)}</ul>
          <RegisterForm draftId={order.id} canWrite={canWrite} />
        </details>)}
      </section>
      <section className={styles.section} aria-labelledby="history"><h2 id="history">Recent receipts</h2><p className={styles.muted}>Latest 20 receipts. Stock balances are snapshots at receipt time. Times shown in UTC.</p>
        {!result.receipts.length ? <p className={styles.empty}>No receipts recorded yet.</p> : <div className="table-wrap"><table><thead><tr><th>Receipt</th><th>Ingredient</th><th>Received</th><th>Stock after</th><th>Still expected</th><th>Recorded (UTC)</th></tr></thead><tbody>
          {result.receipts.map(row => <tr key={row.id}><td><code title={row.id}>{row.id.slice(0, 8)}</code></td><td>{row.name}</td><td>+{row.amount} {row.unit}</td><td>{row.after} {row.unit}</td><td>{row.remaining} {row.unit}</td><td>{new Date(row.created).toISOString().replace("T", " ").slice(0, 19)}</td></tr>)}
        </tbody></table></div>}
      </section><p><a href="/inventory">View updated inventory →</a></p>
    </>}
  </main>;
}
