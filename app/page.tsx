import { RecordedOperations } from "./recorded-operations";
import { hasAgentSession } from "@/lib/agent/auth";
import type { Metadata } from "next";
import { connection } from "next/server";
import { isValidISODate } from "@/lib/agent/date";
import { cafeLocalDate, getDailyBrief } from "@/lib/agent/daily-brief";
import { RefreshBriefButton, RestockApprovalActions } from "./brief-actions";
import { SiteNav } from "./site-nav";
import styles from "./today.module.css";

export const metadata: Metadata = {
  title: "Today | Brewlytics",
  description: "Your café's inventory, deliveries, and agent check for today.",
};

export const maxDuration = 60;

function validDate(value: string | undefined): string | null {
  return value && isValidISODate(value) ? value : null;
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
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  await connection();
  if (!(await hasAgentSession())) return null;
  const query = await searchParams;
  const date = typeof query.date === "string" ? query.date : undefined;
  const today = cafeLocalDate();
  const activeDate = validDate(date) ?? today;
  let brief = null;
  let error = "";
  try {
    brief = await getDailyBrief({ date: activeDate });
  } catch (briefError) {
    console.error("Could not render Today's Brief:", briefError);
    error = "Today's brief couldn't be prepared. Please try refreshing later.";
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
              {activeDate !== today && " · Simulated date"}</p>
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
            <p>Technical details are recorded on the server.</p>
          </section>
        ) : brief && (
          <>
            <section className={styles.intro}>
              <p>Today's outlook</p>
              <h2>{brief.statusLine}</h2>
              <p>{brief.greeting}</p>
              <h2>{brief.status_line}</h2>
            </section>
            <section className={styles.trafficCard} aria-label="Traffic forecast">
              <div className={styles.trafficCardContent}>
                <div className={styles.trafficCardHeading}>
                  <p className="eyebrow">TRAFFIC TODAY</p>
                  <span className={styles.trafficIndicator} data-traffic={brief.traffic.label ?? "unavailable"}>
                    {brief.traffic.label ?? "Unavailable"}
                  </span>
                </div>
                <p className={styles.trafficHeadline}>{brief.traffic.headline}</p>
              </div>
              <div className={styles.trafficMetric}>
                <strong>
                  {brief.traffic.expected_drinks === null
                    ? "—"
                    : new Intl.NumberFormat("en-AU").format(brief.traffic.expected_drinks)}
                </strong>
                <span>drinks expected</span>
                {brief.traffic.low !== null && brief.traffic.high !== null && (
                  <small>
                    Likely range {new Intl.NumberFormat("en-AU").format(brief.traffic.low)}
                    -{new Intl.NumberFormat("en-AU").format(brief.traffic.high)}
                  </small>
                )}
              </div>
              {brief.traffic.note && <p className={styles.trafficNote}>{brief.traffic.note}</p>}
            </section>
            {brief.stock_items.length > 0 && (
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
                {brief.stock_items.map((item) => {
                  const order = item.suggested_order;
                  const approved = /restock was approved/i.test(item.headline);
                  const quantityText = approved && order.quantity !== null
                    ? `Approved restock: ${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(order.quantity)} ${order.unit}`
                    : order.quantity === null
                    ? "Order quantity couldn't be estimated today."
                    : order.quantity === 0
                      ? "No additional order is projected for the next three days."
                      : `Suggested restock: ${new Intl.NumberFormat("en-AU", { maximumFractionDigits: 2 }).format(order.quantity)} ${order.unit}`;
                  const costText = order.estimated_cost === null
                    ? order.quantity !== null && order.quantity > 0
                      ? "No verified supplier price available."
                      : "Cost unavailable until usage and deliveries can be checked."
                    : `About ${new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(order.estimated_cost)}`;
                  return (
                    <article className={styles.item} data-brief-stock-card key={item.ingredient_id}>
                      <h2>{item.headline}</h2>
                      <p>{quantityText}</p>
                      {order.quantity !== 0 && (
                        <p className={styles.actionTaken}>
                          {order.supplier ? `${order.supplier} · ${costText}` : costText}
                        </p>
                      )}
                      {!approved && <RestockApprovalActions item={item} date={brief.briefDate} />}
                      <details className={styles.details}>
                        <summary>Why it needs attention</summary>
                        <p className={styles.detailsContent}>{item.why}</p>
                      </details>
                    </article>
                  );
                })}
              </div>
            )}
            <p className={styles.allClear}>{brief.all_clear}</p>
            {brief.data_warnings.length > 0 && (
              <>
                <p className={styles.dataNote}>Some ingredients couldn't be checked today; see data checks.</p>
                <details className={styles.details}>
                  <summary>Data checks</summary>
                  <ul className={styles.detailsContent}>
                    {brief.data_warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  </ul>
                </details>
              </>
            )}
          </>
        )}
      </section>
      <RecordedOperations date={activeDate} />
    </main>
  );
}
