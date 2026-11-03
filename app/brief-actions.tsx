"use client";

import { useState } from "react";
import type { DailyBrief } from "@/lib/agent/brief-schema";

type BriefAction = DailyBrief["items"][number]["primaryAction"];

function ActionButton({
  action,
  date,
  disabled,
  onError,
}: {
  action: BriefAction;
  date: string;
  disabled: boolean;
  onError: (message: string) => void;
}) {
  async function activate() {
    if ((action.label === "Approve" || action.label === "Dismiss") && action.approvalId) {
      try {
        const response = await fetch("/api/agent/approvals", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "decide",
            id: action.approvalId,
            decision: action.label === "Approve" ? "approved" : "rejected",
            reviewerNote: "Decision made from today's brief.",
          }),
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          const message = typeof result === "object" && result !== null
            && "error" in result && typeof result.error === "string"
            ? result.error
            : "The approval decision could not be saved.";
          throw new Error(message);
        }
        window.location.reload();
      } catch (error) {
        onError(error instanceof Error ? error.message : "The approval decision could not be saved.");
      }
      return;
    }

    window.location.assign(`/?date=${encodeURIComponent(date)}&review=1`);
  }

  return (
    <button className="primary-button" type="button" disabled={disabled} onClick={() => void activate()}>
      {action.label}
    </button>
  );
}

export function RefreshBriefButton({ date }: { date: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: true, date }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : "Today's brief could not be refreshed.";
        throw new Error(message);
      }
      window.location.reload();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Today's brief could not be refreshed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="brief-refresh">
      <button type="button" className="text-button" disabled={busy} onClick={() => void refresh()}>
        {busy ? "Refreshing..." : "Refresh brief"}
      </button>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  );
}

export function BriefItemActions({ item, date }: { item: DailyBrief["items"][number]; date: string }) {
  const [error, setError] = useState("");
  return (
    <div className="brief-actions">
      <ActionButton action={item.primaryAction} date={date} disabled={false} onError={setError} />
      {item.secondaryAction && (
        <ActionButton action={item.secondaryAction} date={date} disabled={false} onError={setError} />
      )}
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  );
}
