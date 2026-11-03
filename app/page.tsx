import type { Metadata } from "next";
import { connection } from "next/server";
import { AgentPanel } from "./automated-ordering/agent-panel";
import { SiteNav } from "./site-nav";
import styles from "./today.module.css";
import { getTodayBrief } from "@/lib/agent/today";

export const metadata: Metadata = {
  title: "Today | Brewlytics",
  description: "Your café's inventory, deliveries, and agent check for today.",
};

export default async function TodayPage() {
  await connection();
  const brief = await getTodayBrief();
  const attentionCount = brief.lowStock.length
    + brief.deliveries.filter((delivery) => delivery.flag !== null).length
    + (brief.draft?.flags.length ?? 0);
  const today = new Date().toISOString().slice(0, 10);
  const nextWeek = new Date(Date.parse(`${today}T00:00:00.000Z`) + 7 * 86_400_000)
    .toISOString().slice(0, 10);
  const deliveries = brief.deliveries.filter((delivery) =>
    (delivery.status !== "complete" || delivery.flag !== null)
    && (delivery.expectedDate <= nextWeek || delivery.status === "overdue"));

  return (
    <main className="page-shell">
      <SiteNav current="today" />
      <section className="orders-section" aria-labelledby="today-title">
        <p className="eyebrow">DAILY BRIEF</p>
        <h1 id="today-title">Today</h1>
        <p className="section-description">
          A quick view of stock, deliveries, and the latest replenishment draft.
          Run a check when you want the agent to review the latest data.
        </p>

        <div className={styles.summaryGrid}>
          <section className={styles.summaryCard} aria-labelledby="stock-title">
            <h2 id="stock-title">Stock needing attention</h2>
            <p className={styles.summaryCount}>{brief.lowStock.length}</p>
            {brief.inventoryError
              ? <p className={styles.attention} role="alert">{brief.inventoryError}</p>
              : brief.lowStock.length
                ? <ul>{brief.lowStock.slice(0, 6).map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>: {item.quantity === null ? "No quantity" : `${item.quantity} ${item.unit}`}
                    {" — "}{item.status}
                  </li>
                ))}</ul>
                : <p className={styles.muted}>No low-stock or missing-stock records.</p>}
          </section>

          <section className={styles.summaryCard} aria-labelledby="delivery-title">
            <h2 id="delivery-title">Arriving deliveries</h2>
            <p className={styles.summaryCount}>{deliveries.length}</p>
            {brief.deliveryError
              ? <p className={styles.attention} role="alert">{brief.deliveryError}</p>
              : deliveries.length
                ? <ul>{deliveries.slice(0, 6).map((delivery) => (
                  <li key={delivery.deliveryId}>
                    <strong>{delivery.ingredient}</strong>: {delivery.receivedQuantity} of {delivery.orderedQuantity} {delivery.unit ?? ""}
                    {" · "}{delivery.status} · expected {delivery.expectedDate}
                    {delivery.flag && <span className={styles.muted}> — {delivery.flag}</span>}
                  </li>
                ))}</ul>
                : <p className={styles.muted}>No open deliveries are listed.</p>}
          </section>

          <section className={styles.summaryCard} aria-labelledby="attention-title">
            <h2 id="attention-title">Items to review</h2>
            <p className={styles.summaryCount}>{attentionCount}</p>
            {brief.draftError && <p className={styles.attention} role="alert">{brief.draftError}</p>}
            {brief.draft
              ? <>
                <p>Latest replenishment draft: <strong>{brief.draft.status}</strong> for {brief.draft.forecastDate}.</p>
                {brief.draft.flags.length > 0 && <ul>
                  {brief.draft.flags.slice(0, 5).map((flag) => <li key={flag}>{flag}</li>)}
                </ul>}
              </>
              : !brief.draftError && <p className={styles.muted}>No replenishment draft has been saved yet.</p>}
          </section>
        </div>

        <AgentPanel initialDraft={brief.draft} />
      </section>
    </main>
  );
}
