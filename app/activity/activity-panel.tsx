"use client";

import { useEffect, useState } from "react";
import type { AgentActivity } from "@/lib/agent/activity-log";
import type { ApprovalItem } from "@/lib/agent/approval-schema";
import { LoadingButton, Skeleton } from "../ui/feedback";
import { formatSydneyDateTime } from "@/lib/owner-communication-model";
import styles from "./activity-panel.module.css";

type ActivityResponse = { items?: AgentActivity[]; approvals?: ApprovalItem[]; error?: string };

function inputFields(summary: string): Array<[string, string]> {
  try {
    const parsed: unknown = JSON.parse(summary);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.entries(parsed).map(([key, value]) => [
        key,
        typeof value === "string" ? value : JSON.stringify(value),
      ]);
    }
  } catch {
    return [["Input", summary]];
  }
  return [["Input", summary]];
}

export function ActivityPanel() {
  const [items, setItems] = useState<AgentActivity[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);

  async function load() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agent/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      const result = await response.json() as ActivityResponse;
      if (!response.ok) throw new Error(result.error || "Activity could not be loaded.");
      setItems(result.items ?? []);
      setApprovals(result.approvals ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Activity could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div className={styles.panel} aria-busy={busy}>
      <LoadingButton className="primary-button" type="button" busy={busy} busyLabel="Loading..." onClick={() => void load()}>
        Refresh activity
      </LoadingButton>
      {error && <p className="form-message error" role="alert">{error}</p>}
      {busy && items.length === 0 && <div className={styles.list} role="status" aria-live="polite">
        <span className="sr-only">Loading activity...</span>
        {Array.from({ length: 3 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
      </div>}
      {items.length === 0 ? (
        !busy && <div className="empty-state"><p>No activity to show yet.</p></div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => <article className={styles.card} key={item.id}>
            <header>
              <div>
                <p className="eyebrow">{item.tool.replaceAll("_", " ")}</p>
                <time dateTime={item.timestamp}>{formatSydneyDateTime(item.timestamp)}</time>
              </div>
              <span className={`${styles.status} ${styles[item.outcome]}`}>{item.outcome}</span>
            </header>
            <dl className={styles.input}>
              {inputFields(item.inputSummary).map(([key, value]) => (
                <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{value || "—"}</dd></div>
              ))}
            </dl>
            <p>{item.reason}</p>
          </article>)}
        </div>
      )}
      <section aria-labelledby="approval-history-title">
        <h2 id="approval-history-title">Approval history</h2>
        {busy && approvals.length === 0 ? (
          <div className={styles.list} role="status" aria-live="polite">
            <span className="sr-only">Loading approval history...</span>
            {Array.from({ length: 2 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
          </div>
        ) : approvals.filter((item) => item.status !== "pending_approval").length === 0 ? (
          <div className="empty-state"><p>No approval decisions have been recorded.</p></div>
        ) : (
          <div className={styles.list}>
            {approvals.filter((item) => item.status !== "pending_approval").slice(0, 20).map((item) => (
              <article className={styles.card} key={item.id}>
                <header>
                  <div>
                    <p className="eyebrow">{item.action.replaceAll("_", " ")}</p>
                    <h3>{item.summary}</h3>
                    <time dateTime={item.reviewedAt ?? item.createdAt}>
                      {formatSydneyDateTime(item.reviewedAt ?? item.createdAt)}
                    </time>
                  </div>
                  <span className={`${styles.status} ${item.status === "rejected" ? styles.error : ""}`}>
                    {item.status}
                  </span>
                </header>
                {item.reviewerNote && <p>{item.reviewerNote}</p>}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
