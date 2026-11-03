import type { Metadata } from "next";
import { SiteNav } from "../site-nav";
import { ActivityPanel } from "./activity-panel";

export const metadata: Metadata = { title: "Activity | Brewlytics" };

export default function ActivityPage() {
  return (
    <main className="page-shell">
      <SiteNav current="activity" />
      <section className="orders-section" aria-labelledby="activity-title">
        <p className="eyebrow">AUDIT TRAIL</p>
        <h1 id="activity-title">Agent activity</h1>
        <p className="section-description">See which tools ran, what they returned, and why.</p>
        <ActivityPanel />
      </section>
    </main>
  );
}
