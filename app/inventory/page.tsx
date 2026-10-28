import type { Metadata } from "next";
import { connection } from "next/server";
import { getInventory } from "@/lib/inventory/server";
import InventoryPanel from "./inventory-panel";

export const metadata: Metadata = { title: "Inventory | Brewlytics" };

export default async function InventoryPage() {
  await connection();
  const result = await getInventory();
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Brewlytics home">
          <span className="wordmark-mark" aria-hidden="true">B</span>
          <span>Brewlytics</span>
        </a>
        <nav className="topbar-nav" aria-label="Main navigation">
          <a href="/orders">Orders</a>
          <a href="/inventory" aria-current="page">Inventory</a>
          <a href="/automated-ordering">AI Forecast</a>
          <a href="/order-requests">Supply requests</a>
        </nav>
      </header>
      <section style={{ margin: "40px 0 64px" }} aria-labelledby="inventory-title">
        <p className="eyebrow">DAILY OPERATIONS</p>
        <h1 id="inventory-title">Inventory check</h1>
        <p className="section-description">Check recorded stock and identify ingredients that need replenishment.</p>
        {result.error ? <p className="notice" role="alert">{result.error}</p> :
          <InventoryPanel items={result.items} canWrite={process.env.NODE_ENV === "development"} />}
      </section>
    </main>
  );
}
