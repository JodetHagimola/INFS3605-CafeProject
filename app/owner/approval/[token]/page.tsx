import type { Metadata } from "next";
import { getOwnerApprovalLink } from "@/lib/owner-communication";

export const metadata: Metadata = {
  title: "Review approval | Brewlytics",
  robots: { index: false, follow: false },
};

export default async function OwnerApprovalLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  let link: Awaited<ReturnType<typeof getOwnerApprovalLink>> = null;
  let unavailable = false;
  try {
    link = await getOwnerApprovalLink(token);
  } catch (error) {
    console.error("Could not load an owner approval link:", error instanceof Error ? error.message : "Unknown error");
    unavailable = true;
  }

  return (
    <main className="page-shell">
      <section className="orders-section" aria-labelledby="owner-approval-title">
        <p className="eyebrow">BREWLYTICS · OWNER REVIEW</p>
        <h1 id="owner-approval-title">Review this request</h1>
        {unavailable ? (
          <p role="alert">This approval link could not be checked. Please try again later.</p>
        ) : !link ? (
          <p>This link has expired, has already been used, or the request is no longer pending.</p>
        ) : (
          <section className="form-card">
            <h2>{link.summary}</h2>
            {link.action === "approve" ? (
              <>
                <p>Reviewing this page does not approve the request. Confirm below to record your decision.</p>
                <form action="/api/owner/approval-link" method="post">
                  <input type="hidden" name="token" value={token} />
                  <input type="hidden" name="action" value="approve" />
                  <input type="hidden" name="decision" value="approved" />
                  <button className="primary-button" type="submit">Approve request</button>
                </form>
              </>
            ) : (
              <form action="/api/owner/approval-link" method="post">
                <input type="hidden" name="token" value={token} />
                <input type="hidden" name="action" value="edit" />
                <label>
                  Request summary
                  <input name="summary" defaultValue={link.summary} maxLength={500} required />
                </label>
                <label>
                  Request details (JSON)
                  <textarea
                    name="details"
                    defaultValue={JSON.stringify(link.details, null, 2)}
                    rows={12}
                    maxLength={20_000}
                    required
                  />
                </label>
                <p>Saving edits does not approve the request. It will remain in the approval inbox.</p>
                <button className="primary-button" type="submit">Save edits</button>
              </form>
            )}
            <p className="muted">This single-use link expires {new Date(link.expiresAt).toLocaleString("en-AU", {
              timeZone: "Australia/Sydney",
              dateStyle: "medium",
              timeStyle: "short",
            })} Sydney time.</p>
          </section>
        )}
      </section>
    </main>
  );
}
