
import { connection } from "next/server";
import { getLatestDraft } from "@/lib/agent/server";
import { AgentPanel } from "./agent-panel";

export default async function AutomatedOrderingPage() {
  await connection();
  const { draft, error } = await getLatestDraft();
  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Brewlytics home">
          <span className="wordmark-mark" aria-hidden="true">B</span>
          <span>Brewlytics</span>
        </a>
        <nav className="topbar-nav" aria-label="Main navigation">
          <a href="/orders">Orders</a>
          <a href="/inventory">Inventory</a>
          <a href="/order-requests">Supply requests</a>
        </nav>
      </header>
      <section className="orders-section" aria-labelledby="automated-ordering-title">
        <h1 id="automated-ordering-title">AI Automated Ordering</h1>
        <p className="section-description">
          Review a forecast-based replenishment draft. The AI can only read the
          approved café data and save a draft; it cannot contact suppliers or
          change stock.
        </p>
        {error && <p className="form-message error" role="alert">{error}</p>}
        <AgentPanel initialDraft={draft} />
      </section>
    </main>
  );
}
