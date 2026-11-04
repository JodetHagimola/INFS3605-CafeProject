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

export default async function TodayPage({
  searchParams,
}: {
  searchParams: Promise<{ date?: string | string[] }>;
}) {
  await connection();
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
              {activeDate !== today && " · Simulated date"}</p>
            <RefreshBriefButton date={activeDate} />
          </div>
        </div>
        {error ? (
          <section className={styles.emptyState} role="status">
            <h2>I couldn't prepare today's brief.</h2>
            <p>{error}</p>
            <p>Technical details are recorded on the server.</p>
          </section>
        ) : brief && (
          <>
            <section className={styles.intro}>
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
    </main>
  );
}
