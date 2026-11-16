import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Approval update | Brewlytics",
  robots: { index: false, follow: false },
};

const messages: Record<string, string> = {
  approved: "Your approval was recorded. Brewly will continue processing the request.",
  edited: "Your edits were saved. The request remains pending approval.",
  used: "This single-use link has already been used.",
  invalid: "This link is invalid or has expired.",
  stale: "This request is no longer pending.",
};

export default async function OwnerApprovalCompletePage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;
  const message = status ? messages[status] : null;
  return (
    <main className="page-shell">
      <section className="orders-section" aria-labelledby="approval-result-title">
        <p className="eyebrow">BREWLYTICS · OWNER REVIEW</p>
        <h1 id="approval-result-title">Approval update</h1>
        <p role={message ? "status" : "alert"}>{message ?? "The approval link result is unavailable."}</p>
        <Link className="primary-button" href="/">Return to Today</Link>
      </section>
    </main>
  );
}
