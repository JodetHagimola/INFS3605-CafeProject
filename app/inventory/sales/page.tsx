import type { Metadata } from "next";
import { connection } from "next/server";
import { getRecentSales, getSaleProducts } from "@/lib/inventory-sales/server";
import { displaySaleTime } from "@/lib/inventory-sales/model";
import SaleForm from "./sale-form";
import styles from "./sales.module.css";

export const metadata: Metadata = { title: "Record sale | Brewlytics" };

export default async function InventorySalesPage() {
  await connection();
  const [recipes, history] = await Promise.all([getSaleProducts(), getRecentSales()]);
  return <main className={`page-shell ${styles.page}`}>
    <header className="topbar">
      <a className="wordmark" href="/">Brewlytics</a>
      <nav className="topbar-nav" aria-label="Inventory navigation">
        <a href="/inventory">Inventory</a>
        <a href="/inventory/sales" aria-current="page">Record sale</a>
        <a href="/automated-ordering">AI Forecast</a>
      </nav>
    </header>
    <section className={styles.heading} aria-labelledby="sales-title">
      <p className="eyebrow">DAILY OPERATIONS</p><h1 id="sales-title">Record sale</h1>
      <p className="section-description">Enter drinks sold. Recipe quantities are deducted from recorded stock.</p>
    </section>
    {recipes.error ? <p className="notice" role="alert">{recipes.error}</p>
      : recipes.products.length === 0 ? <p className="notice">No recipes are available. Add recipes before recording sales.</p>
      : <SaleForm products={recipes.products} canWrite={process.env.NODE_ENV === "development"} />}
    <section className={styles.history} aria-labelledby="history-title">
      <h2 id="history-title">Recent sales</h2>
      <p>Latest 10 entries. Each reference identifies one sale.</p>
      {history.error ? <p className="notice">{history.error}</p> : history.sales.length === 0 ? <p>No sales recorded yet.</p>
        : <div className={styles.tableWrap}><table>
          <thead><tr><th>Recorded (UTC)</th><th>Drink</th><th>Quantity</th><th>Reference</th></tr></thead>
          <tbody>{history.sales.map(s => <tr key={s.id}>
            <td><time dateTime={s.created_at}>{displaySaleTime(s.created_at)}</time></td>
            <td>{s.product_name}</td><td>{s.quantity}</td><td className={styles.reference}><code>{s.id}</code></td>
          </tr>)}</tbody>
        </table></div>}
    </section>
    <p className={styles.footnote}>Sales are entered manually in this prototype. There is no live POS connection. Deliveries and waste are recorded on the Inventory page.</p>
  </main>;
}
