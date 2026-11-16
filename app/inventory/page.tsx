import { hasAgentSession } from "@/lib/agent/auth";
import { redirect } from "next/navigation";
import type { Metadata } from "next";
import { connection } from "next/server";
import { getInventory } from "@/lib/inventory/server";
import { inventoryWritesEnabled } from "@/lib/inventory/write-policy";
import { SiteNav } from "../site-nav";
import InventoryPanel from "./inventory-panel";

export const metadata: Metadata = { title: "Inventory | Brewlytics" };

export default async function InventoryPage() {
  await connection();
  if (!(await hasAgentSession())) redirect("/");
  const result = await getInventory();
  return (
    <main className="page-shell">
      <SiteNav current="stock" />
      <section style={{ margin: "40px 0 64px" }} aria-labelledby="inventory-title">
        <p className="eyebrow">DAILY OPERATIONS</p>
        <h1 id="inventory-title">Stock at a glance</h1>
        <p className="section-description">Brewly keeps this up to date. Correct a number only after checking the physical stock.</p>
        {result.error ? <p className="notice" role="alert">{result.error}</p> :
          <InventoryPanel items={result.items} canWrite={inventoryWritesEnabled()} />}
      </section>
    </main>
  );
}
