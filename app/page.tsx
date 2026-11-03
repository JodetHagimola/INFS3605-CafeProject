import type { Metadata } from "next";
import { connection } from "next/server";
import { cafeLocalDate, getDailyBrief } from "@/lib/agent/daily-brief";
import { BriefItemActions, RefreshBriefButton } from "./brief-actions";
import { InboxPanel } from "./inbox/inbox-panel";
import { SiteNav } from "./site-nav";
import styles from "./today.module.css";

export const metadata: Metadata = {
  title: "Today | Brewlytics",
  description: "Your café's inventory, deliveries, and agent check for today.",
};

function validDate(value: string | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[]; review?: string | string[] }>;
}) {
  await connection();
  const query = await searchParams;
  const date = typeof query.date === "string" ? query.date : undefined;
  const activeDate = validDate(date) ?? cafeLocalDate();
  let brief = null;
  let error = "";
  try {
    brief = await getDailyBrief({ date });
  } catch (briefError) {
    error = briefError instanceof Error
      ? briefError.message
      : "Today's brief could not be prepared. Please try again later.";
  }

  return (
    <main className="page-shell">
      <SiteNav current="today" />
      <section className={styles.brief} aria-labelledby="today-title">
        <p className="eyebrow">DAILY BRIEF</p>
        <h1 id="today-title">Today</h1>
        <div className={styles.briefHeading}>
          <div>
            <p className={styles.date}>{new Intl.DateTimeFormat("en-AU", {
              dateStyle: "full",
              timeZone: "Australia/Sydney",
            }).format(new Date(`${activeDate}T12:00:00.000Z`))}
              {activeDate !== cafeLocalDate() && " · Simulated date"}</p>
            <RefreshBriefButton date={activeDate} />
          </div>
        </div>
        {error ? (
          <section className={styles.emptyState} role="status">
            <h2>I couldn't prepare today's brief.</h2>
            <p>{error}</p>
            <p>Try refreshing later; technical details are recorded on the server.</p>
          </section>
        ) : brief && (
          <>
            <section className={styles.intro}>
              <p>{brief.greeting}</p>
              <h2>{brief.statusLine}</h2>
            </section>
            {brief.items.length > 0 ? (
              <div className={styles.items}>
                {brief.items.map((item) => (
                  <article className={styles.item} data-brief-action-card key={item.id}>
                    <h2>{item.title}</h2>
                    <p>{item.why}</p>
                    <p className={styles.actionTaken}>{item.actionTaken}</p>
                    <BriefItemActions item={item} date={brief.briefDate} />
                  </article>
                ))}
              </div>
            ) : (
              <section className={styles.emptyState}>
                <h2>All clear</h2>
                <p>{brief.allClear}</p>
              </section>
            )}
            {brief.items.length > 0 && <p className={styles.allClear}>{brief.allClear}</p>}
            <details className={styles.details}>
              <summary>See details</summary>
              <div className={styles.detailsContent}>
                {brief.details.lowStock.length > 0 && <>
                  <h3>Stock</h3>
                  <ul>{brief.details.lowStock.map((item) => (
                    <li key={item.ingredientId}>
                      {item.ingredient}: {item.quantity === null ? "unknown quantity" : `${item.quantity} ${item.unit}`}
                      {" · "}{item.status}
                    </li>
                  ))}</ul>
                </>}
                {brief.details.forecasts.length > 0 && <>
                  <h3>Forecast</h3>
                  <div className={styles.tableWrap}>
                    <table>
                      <thead><tr><th>Date</th><th>Product</th><th>Low</th><th>Expected</th><th>High</th></tr></thead>
                      <tbody>{brief.details.forecasts.map((forecast, index) => (
                        <tr key={`${forecast.date}-${forecast.product}-${index}`}>
                          <td>{forecast.date}</td>
                          <td>{forecast.product}</td>
                          <td>{forecast.low}</td>
                          <td>{forecast.expected}</td>
                          <td>{forecast.high}</td>
                        </tr>
                      ))}</tbody>
                    </table>
                  </div>
                </>}
                {brief.details.deliveries.length > 0 && <>
                  <h3>Deliveries</h3>
                  <ul>{brief.details.deliveries.map((delivery) => (
                    <li key={delivery.deliveryId}>
                      {delivery.ingredient}: {delivery.receivedQuantity} received of {delivery.orderedQuantity},
                      {" expected "}{delivery.expectedDate} · {delivery.status}
                      {delivery.flag && ` · ${delivery.flag}`}
                    </li>
                  ))}</ul>
                </>}
                {brief.details.supplierComparison.length > 0 && <>
                  <h3>Supplier comparison</h3>
                  <ul>{brief.details.supplierComparison.map((supplier, index) => (
                    <li key={`${supplier.ingredient}-${supplier.supplier}-${index}`}>
                      {supplier.ingredient}: {supplier.supplier}, {supplier.price}, {supplier.deliveryTime}
                    </li>
                  ))}</ul>
                </>}
                {brief.details.assumptions.length > 0 && <>
                  <h3>Assumptions</h3>
                  <ul>{brief.details.assumptions.map((value) => <li key={value}>{value}</li>)}</ul>
                </>}
                {brief.details.dataWarnings.length > 0 && <>
                  <h3>Data notes</h3>
                  <ul>{brief.details.dataWarnings.map((value) => <li key={value}>{value}</li>)}</ul>
                </>}
              </div>
            </details>
          </>
        )}
      </section>
      <details className={styles.details} open={query.review === "1"}>
        <summary>Approvals and items needing attention</summary>
        <InboxPanel />
      </details>
    </main>
  );
}
