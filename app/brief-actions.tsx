"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import type { DailyBriefStockItem } from "@/lib/agent/brief-schema";
import { LoadingButton } from "./ui/feedback";
import styles from "./today.module.css";

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

export function RestockApprovalActions({
  item,
  date,
}: {
  item: DailyBriefStockItem;
  date: string;
}) {
  const router = useRouter();
  const [quantity, setQuantity] = useState(String(item.suggested_order.quantity ?? ""));
  const [quantityDraft, setQuantityDraft] = useState(String(item.suggested_order.quantity ?? ""));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState("");
  const busyRef = useRef(false);
  const suggestedQuantity = item.suggested_order.quantity;

  if (!item.approve_action_id || !item.suggested_order.supplier
    || suggestedQuantity === null || suggestedQuantity <= 0) return null;

  async function approve(button: HTMLButtonElement) {
    if (busyRef.current || success) return;
    const parsedQuantity = Number(quantity);
    if (!Number.isSafeInteger(parsedQuantity) || parsedQuantity <= 0 || parsedQuantity > 100_000) {
      setError("Enter a whole-number quantity between 1 and 100,000.");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agent/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "approve-restock",
          actionId: item.approve_action_id,
          date,
          quantity: parsedQuantity,
        }),
      });
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new Error("The server returned an invalid approval response.");
      }
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : "The restock approval could not be saved.";
        throw new Error(message);
      }

      setSuccess(true);
      setBusy(false);
      const card = button.closest<HTMLElement>("[data-brief-stock-card]");
      window.setTimeout(() => card?.classList.add(styles.itemCollapsing), 0);
      window.setTimeout(() => router.refresh(), 260);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The restock approval could not be saved.");
      busyRef.current = false;
      setBusy(false);
    }
  }

  function applyQuantity() {
    const parsed = Number(quantityDraft);
    if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100_000) {
      setError("Enter a whole-number quantity between 1 and 100,000.");
      return;
    }
    setQuantity(String(parsed));
    setEditing(false);
    setError("");
  }

  return (
    <div className="brief-actions">
      {editing ? (
        <div className={styles.quantityEditor}>
          <label>
            Order quantity ({item.suggested_order.unit})
            <input
              type="number"
              min={1}
              max={100_000}
              step={1}
              inputMode="numeric"
              value={quantityDraft}
              onChange={(event) => setQuantityDraft(event.target.value)}
            />
          </label>
          <button type="button" disabled={busy} onClick={applyQuantity}>Save quantity</button>
          <button type="button" disabled={busy} onClick={() => {
            setQuantityDraft(quantity);
            setEditing(false);
            setError("");
          }}>Cancel</button>
        </div>
      ) : (
        <>
          <LoadingButton
            className="primary-button"
            type="button"
            busy={busy}
            busyLabel="Approving..."
            success={success}
            successLabel="Approved"
            disabled={success}
            onClick={(event) => void approve(event.currentTarget)}
          >
            Approve restock
          </LoadingButton>
          <button
            type="button"
            className="text-button"
            disabled={busy || success}
            onClick={() => {
              setQuantityDraft(quantity);
              setEditing(true);
              setError("");
            }}
          >
            Edit quantity
          </button>
        </>
      )}
      {error && <p className="form-message error" role="alert">{error}</p>}
      {quantity !== String(suggestedQuantity) && !editing && (
        <p className={styles.actionTaken}>Edited quantity: {quantity} {item.suggested_order.unit}. The current supplier price is verified when you approve.</p>
      )}
    </div>
  );
}
