import type { Metadata } from "next";
import { SiteNav } from "../site-nav";
import { InboxPanel } from "./inbox-panel";

export const metadata: Metadata = { title: "Inbox | Brewlytics" };

export default function InboxPage() {
  return (
    <main className="page-shell">
      <SiteNav current="inbox" />
      <section className="orders-section" aria-labelledby="inbox-title">
        <p className="eyebrow">HUMAN REVIEW</p>
        <h1 id="inbox-title">Approval inbox</h1>
        <p className="section-description">
          Review agent requests involving suppliers or purchasing. Approving
          records your decision only; it never sends an order or contacts anyone.
        </p>
        <InboxPanel />
      </section>
    </main>
  );
}
