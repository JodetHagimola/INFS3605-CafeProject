import { RecordedOperations } from "./recorded-operations";
import { hasAgentSession } from "@/lib/agent/auth";
import type { Metadata } from "next";
import { connection } from "next/server";
import { isValidISODate } from "@/lib/agent/date";
import { cafeLocalDate, getDailyBrief } from "@/lib/agent/daily-brief";
import { getOwnerCommunication } from "@/lib/owner-communication";
import { cafeDayPhase } from "@/lib/owner-communication-model";
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

function shiftDate(date: string, days: number): string {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`) + days * 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString().slice(0, 10);
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
  let tomorrowBrief = null;
  let communication = null;
  let error = "";
  try {
    communication = await getOwnerCommunication(activeDate);
    const isAfterClose = activeDate === today
      && cafeDayPhase(new Date(), communication.settings.openTime, communication.settings.closeTime) === "wrap_up";
    brief = await getDailyBrief({ date: activeDate, allowApprovals: !isAfterClose });
    if (isAfterClose) {
      tomorrowBrief = await getDailyBrief({ date: shiftDate(activeDate, 1), allowApprovals: false });
    }
  } catch (briefError) {
    console.error("Could not render Today's Brief:", briefError);
    error = "Today's brief couldn't be prepared. Please try refreshing later.";
  }
  const phase = communication
    ? cafeDayPhase(new Date(), communication.settings.openTime, communication.settings.closeTime)
    : "operating";
  const decisions = communication?.isRush ? [] : communication?.decisions ?? [];
  const stockItems = communication?.isRush
    ? []
    : brief?.stock_items.slice(0, Math.max(0, 3 - decisions.length)) ?? [];
  return (
    <main className="page-shell">
      <SiteNav current="today" />
      <section className={styles.brief} aria-labelledby="today-title">
        <p className="eyebrow">DAILY BRIEF</p>
        <h1 id="today-title">{phase === "pre_open" ? "Morning brief" : phase === "wrap_up" ? "End-of-day wrap-up" : "Today"}</h1>
        {phase === "pre_open" && communication?.settings.ownerName && (
          <p className={styles.welcome}>For {communication.settings.ownerName}</p>
        )}
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
              <h2>{communication?.isRush ? "Your café at a glance" : brief.status_line}</h2>
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
            {communication && (
              <section className={styles.handled} aria-labelledby="handled-title">
                <h2 id="handled-title">Brewly handled</h2>
                <ul>
                  <li>{communication.handled.sales ?? "—"} sales recorded</li>
                  <li>{communication.handled.deliveries ?? "—"} deliveries received</li>
                  <li>{communication.handled.orders} simulated orders registered</li>
                  <li>{communication.handled.emails} test emails delivered</li>
                </ul>
              </section>
            )}
            {decisions.length > 0 && (
              <section className={styles.items} aria-labelledby="decisions-title">
                <h2 id="decisions-title">Decisions</h2>
                {decisions.map((decision) => (
                  <article className={styles.item} key={decision.id}>
                    <h3>{decision.summary}</h3>
                    <a className="primary-button" href="/inbox">Review request</a>
                  </article>
                ))}
              </section>
            )}
            {stockItems.length > 0 && (
              <div className={styles.items}>
                {stockItems.map((item) => {
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
            <p className={styles.allClear}>
              {communication?.isRush
                ? "Non-urgent decisions will return after the rush."
                : brief.all_clear}
            </p>
            {phase === "wrap_up" && tomorrowBrief && (
              <section className={styles.tomorrow} aria-labelledby="tomorrow-title">
                <p className="eyebrow">TOMORROW</p>
                <h2 id="tomorrow-title">Tomorrow's outlook</h2>
                <p>{tomorrowBrief.traffic.headline}</p>
                {tomorrowBrief.traffic.expected_drinks !== null && (
                  <p>{new Intl.NumberFormat("en-AU").format(tomorrowBrief.traffic.expected_drinks)} drinks expected.</p>
                )}
              </section>
            )}
            {(brief.data_warnings.length > 0 || communication && !communication.activitySummaryAvailable) && (
              <details className={styles.details}>
                <summary>Data checks</summary>
                <ul className={styles.detailsContent}>
                  {brief.data_warnings.map((warning) => <li key={warning}>{warning}</li>)}
                  {communication && !communication.activitySummaryAvailable
                    && <li>Recorded sales and delivery activity could not be loaded.</li>}
                </ul>
              </details>
            )}
          </>
        )}
      </section>
      <RecordedOperations date={activeDate} />
    </main>
  );
}
