"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { DailyBrief } from "@/lib/agent/brief-schema";
import { LoadingButton } from "./ui/feedback";
import styles from "./today.module.css";

type BriefAction = DailyBrief["items"][number]["primaryAction"];

function ActionButton({
  action,
  date,
  disabled,
  onError,
  onBusyChange,
}: {
  action: BriefAction;
  date: string;
  disabled: boolean;
  onError: (message: string) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);

  async function activate(button: HTMLButtonElement) {
    if ((action.label === "Approve" || action.label === "Dismiss") && action.approvalId) {
      if (busy) return;
      setBusy(true);
      onBusyChange(true);
      setSuccess(false);
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
        setSuccess(true);
        const card = button.closest<HTMLElement>("[data-brief-action-card]");
        window.setTimeout(() => card?.classList.add(styles.itemCollapsing), 0);
        window.setTimeout(() => {
          router.refresh();
          setBusy(false);
          onBusyChange(false);
        }, 260);
        window.setTimeout(() => setSuccess(false), 1000);
      } catch (error) {
        onError(error instanceof Error ? error.message : "The approval decision could not be saved.");
        setBusy(false);
        onBusyChange(false);
      }
      return;
    }

    window.location.assign(`/?date=${encodeURIComponent(date)}&review=1`);
  }

  return (
    <LoadingButton className="primary-button" type="button" disabled={disabled || success} busy={busy} busyLabel={`${action.label}...`} success={success} successLabel="Saved" onClick={(event) => void activate(event.currentTarget)}>
      {action.label}
    </LoadingButton>
  );
}

export function RefreshBriefButton({ date }: { date: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState(false);

  async function refresh() {
    setBusy(true);
    setSuccess(false);
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
      setSuccess(true);
      window.setTimeout(() => router.refresh(), 240);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Today's brief could not be refreshed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="brief-refresh">
      <LoadingButton type="button" className="text-button" busy={busy} busyLabel="Refreshing..." success={success} successLabel="Ready" onClick={() => void refresh()}>
        Refresh brief
      </LoadingButton>
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  );
}

export function BriefItemActions({ item, date }: { item: DailyBrief["items"][number]; date: string }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="brief-actions">
      <ActionButton action={item.primaryAction} date={date} disabled={busy} onError={setError} onBusyChange={setBusy} />
      {item.secondaryAction && (
        <ActionButton action={item.secondaryAction} date={date} disabled={busy} onError={setError} onBusyChange={setBusy} />
      )}
      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  );
}
