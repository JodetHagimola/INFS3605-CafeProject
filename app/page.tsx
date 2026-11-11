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

function ownerGreeting(): string {
  const hour = Number(new Intl.DateTimeFormat("en-AU", {
    timeZone: "Australia/Sydney",
    hour: "numeric",
    hourCycle: "h23",
  }).format(new Date()));
  const timeOfDay = hour < 12 ? "morning" : hour < 17 ? "afternoon" : "evening";
  return `Good ${timeOfDay}, Margaret`;
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
  const expectedDrinks = brief?.details.forecasts.filter((forecast) => forecast.date === activeDate) ?? [];
  const totalExpectedDrinks = expectedDrinks.reduce((total, forecast) => total + forecast.expected, 0);

  return (
    <main className="page-shell">
      <SiteNav current="today" />
      <section className={styles.brief} aria-labelledby="today-title">
        <p className={styles.welcome}>{ownerGreeting()}</p>
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
        {expectedDrinks.length > 0 && (
          <section className={styles.forecast} aria-labelledby="forecast-title">
            <header className={styles.forecastHeading}>
              <div>
                <p className="eyebrow">TODAY'S ESTIMATE</p>
                <h2 id="forecast-title">Drinks expected to sell</h2>
              </div>
              <p><strong>{totalExpectedDrinks.toLocaleString("en-AU")}</strong> drinks total</p>
            </header>
            <div className={styles.forecastCards}>
              {expectedDrinks.map((forecast, index) => (
                <article className={styles.forecastCard} key={`${forecast.product}-${index}`}>
                  <span className={styles.cupIcon} aria-hidden="true">
                    <svg viewBox="0 0 24 24" fill="none">
                      <path d="M4 8h13v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8Z" />
                      <path d="M17 10h1.5a2.5 2.5 0 1 1 0 5H17M7 4v2m4-2v2m4-2v2" />
                    </svg>
                  </span>
                  <strong>{forecast.expected.toLocaleString("en-AU")}</strong>
                  <span><b>{forecast.product}</b> expected</span>
                </article>
              ))}
            </div>
            <p className={styles.forecastNote}>Forecasts are estimates based on available sales history.</p>
          </section>
        )}
        {error ? (
          <section className={styles.emptyState} role="status">
            <h2>I couldn't prepare today's brief.</h2>
            <p>{error}</p>
            <p>Try refreshing later; technical details are recorded on the server.</p>
          </section>
        ) : brief && (
          <>
            <section className={styles.intro}>
              <p>Today's outlook</p>
              <h2>{brief.statusLine}</h2>
            </section>
            {brief.items.length > 0 ? (
              <div className={styles.items}>
                {brief.items.map((item) => (
                  <article className={styles.item} data-brief-action-card key={item.id}>
                    <div className={styles.itemHeading}>
                      <span className={styles.attentionIcon} aria-hidden="true">!</span>
                      <h2>{item.title}</h2>
                    </div>
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
