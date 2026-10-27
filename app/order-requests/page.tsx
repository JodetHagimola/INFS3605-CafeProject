import type { Metadata } from "next";
import { connection } from "next/server";
import type { OrderRequest } from "@/lib/order-requests/server";
import { getOrderRequests } from "@/lib/order-requests/server";
import { DecisionForm } from "./decision-form";
import { OrderRequestForm } from "./order-request-form";

export const metadata: Metadata = { title: "Supply requests | Brewlytics" };

function RequestCard({ request }: { request: OrderRequest }) {
  return (
    <article className="request-card">
      <div className="request-card-heading">
        <div>
          <p className="eyebrow">Requested by {request.chefName}</p>
          <h2>Needed by <time dateTime={request.neededBy}>{request.neededBy}</time></h2>
        </div>
        <span className={`request-status ${request.status}`}>{request.status}</span>
      </div>

      <ul className="request-item-list">
        {request.items.map((item, index) => (
          <li key={`${request.id}-${index}`}>
            <span>{item.name}</span>
            <strong>{item.quantity} {item.unit}</strong>
          </li>
        ))}
      </ul>

      {request.notes && <p className="request-notes"><strong>Chef notes:</strong> {request.notes}</p>}

      {request.status === "pending" ? (
        <div className="decision-actions">
          <DecisionForm id={request.id} decision="approved" />
          <DecisionForm id={request.id} decision="rejected" />
        </div>
      ) : (
        <div className="decision-summary">
          <p>
            {request.status === "approved" ? "Approved" : "Rejected"} by{" "}
            <strong>{request.approverName ?? "Approver"}</strong>
            {request.decidedAt && (
              <> on <time dateTime={request.decidedAt}>{new Date(request.decidedAt).toLocaleString()}</time></>
            )}
          </p>
          {request.decisionNote && <p>{request.decisionNote}</p>}
        </div>
      )}
    </article>
  );
}

export default async function OrderRequestsPage() {
  await connection();
  const result = await getOrderRequests();
  const pending = result.error ? [] : result.requests.filter((request) => request.status === "pending");
  const decided = result.error ? [] : result.requests.filter((request) => request.status !== "pending");

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
          <a href="/order-requests" aria-current="page">Supply requests</a>
        </nav>
      </header>

      <section className="orders-section" aria-labelledby="requests-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">PURCHASING</p>
            <h1 id="requests-title">Order requests</h1>
            <p className="section-description">Submit supply needs for review and track approval decisions.</p>
          </div>
          {!result.error && (
            <p className="order-count">
              <strong>{pending.length}</strong>
              <span>awaiting review</span>
            </p>
          )}
        </div>

        <div className="request-layout">
          <section aria-labelledby="submit-request-title">
            <h2 className="subsection-title" id="submit-request-title">Place an order</h2>
            <OrderRequestForm />
          </section>

          <section className="approval-queue" aria-labelledby="approval-queue-title">
            <div className="queue-heading">
              <h2 className="subsection-title" id="approval-queue-title">Approver queue</h2>
              {!result.error && <span>{pending.length} awaiting review</span>}
            </div>
            {result.error ? (
              <div className="notice" role="alert"><p>{result.error}</p></div>
            ) : result.requests.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">No order requests yet</p>
                <p>Submitted orders will appear here for approval.</p>
              </div>
            ) : (
              <div className="request-list">
                {pending.map((request) => <RequestCard key={request.id} request={request} />)}
                {decided.length > 0 && (
                  <>
                    <h3 className="history-title">Reviewed orders</h3>
                    {decided.map((request) => <RequestCard key={request.id} request={request} />)}
                  </>
                )}
              </div>
            )}
          </section>
        </div>
        <p className="shared-demo-note">Shared demo workflow: anyone with access to this page can submit, approve, or reject orders.</p>
      </section>
    </main>
  );
}
