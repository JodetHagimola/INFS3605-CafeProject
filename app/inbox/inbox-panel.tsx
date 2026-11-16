"use client";

import { useEffect, useState } from "react";
import type { ApprovalItem } from "@/lib/agent/approval-schema";
import type { AgentActivity } from "@/lib/agent/activity-log";
import { LoadingButton, Skeleton } from "../ui/feedback";
import { formatSydneyDateTime } from "@/lib/owner-communication-model";
import styles from "./inbox-panel.module.css";

type ApiResult = {
  error?: string;
  items?: ApprovalItem[];
  flags?: AgentActivity[];
  status?: string;
};

function parseDetails(item: ApprovalItem, values: Record<string, string>) {
  const details: ApprovalItem["details"] = {};
  for (const [key, original] of Object.entries(item.details)) {
    const value = values[key] ?? String(original ?? "");
    if (typeof original === "number") {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) throw new Error(`${key} must be a valid number.`);
      details[key] = parsed;
    } else if (typeof original === "boolean") {
      if (value !== "true" && value !== "false") throw new Error(`${key} must be true or false.`);
      details[key] = value === "true";
    } else {
      details[key] = value || (original === null ? null : "");
    }
  }
  return details;
}

export function InboxPanel() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  const [flags, setFlags] = useState<AgentActivity[]>([]);
  const [editingId, setEditingId] = useState("");
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [details, setDetails] = useState<Record<string, Record<string, string>>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [collapsingId, setCollapsingId] = useState("");
  const [successAction, setSuccessAction] = useState("");

  async function send(payload: Record<string, unknown>): Promise<ApiResult> {
    const response = await fetch("/api/agent/approvals", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    let result: unknown;
    try {
      result = await response.json();
    } catch {
      throw new Error("The server returned an invalid response.");
    }
    if (typeof result !== "object" || result === null || Array.isArray(result)) {
      throw new Error("The server returned an invalid response.");
    }
    const parsed = result as ApiResult;
    if (!response.ok) throw new Error(parsed.error || "The approval request failed.");
    return parsed;
  }

  async function loadInbox() {
    setBusy(true);
    setBusyAction("load");
    setError("");
    try {
      const result = await send({ operation: "list" });
      setItems(result.items ?? []);
      setFlags(result.flags ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The inbox could not be loaded.");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  }

  useEffect(() => {
    void loadInbox();
  }, []);

  async function saveEdit(item: ApprovalItem) {
    setBusy(true);
    setBusyAction(`save:${item.id}`);
    setSuccessAction("");
    setError("");
    try {
      const updatedDetails = parseDetails(item, details[item.id] ?? {});
      await send({
        operation: "edit",
        id: item.id,
        summary: summaries[item.id] ?? item.summary,
        details: updatedDetails,
      });
      setSuccessAction(`save:${item.id}`);
      await new Promise((resolve) => window.setTimeout(
        resolve,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 240,
      ));
      setItems((current) => current.map((entry) => entry.id === item.id
        ? { ...entry, summary: summaries[item.id] ?? entry.summary, details: updatedDetails }
        : entry));
      setEditingId("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The approval item could not be edited.");
    } finally {
      setBusy(false);
      setBusyAction("");
      setSuccessAction("");
    }
  }

  async function decide(item: ApprovalItem, decision: "approved" | "rejected") {
    setBusy(true);
    setBusyAction(`${decision}:${item.id}`);
    setError("");
    try {
      await send({
        operation: "decide",
        id: item.id,
        decision,
        reviewerNote: notes[item.id] ?? "",
      });
      setCollapsingId(item.id);
      await new Promise((resolve) => window.setTimeout(
        resolve,
        window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 1 : 240,
      ));
      setItems((current) => current.map((entry) => entry.id === item.id
        ? {
          ...entry,
          status: decision,
          reviewedAt: new Date().toISOString(),
          reviewerNote: notes[item.id] ?? "",
        }
        : entry));
      setCollapsingId("");
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "The decision could not be saved.");
    } finally {
      setCollapsingId("");
      setBusy(false);
      setBusyAction("");
    }
  }

  const pending = items.filter((item) => item.status === "pending_approval");
  const reviewed = items.filter((item) => item.status !== "pending_approval");
  const attentionHeading = busy && flags.length === 0
    ? "Checking for items needing attention"
    : flags.length === 0
      ? "All clear"
      : `${flags.length} item${flags.length === 1 ? "" : "s"} ${flags.length === 1 ? "needs" : "need"} attention`;
  const attentionStateClass = flags.length > 0
    ? styles.attentionHasFlags
    : busy
      ? styles.attentionLoading
      : styles.attentionClear;

  return (
    <div className={styles.panel} aria-busy={busy}>
      <LoadingButton className="primary-button" type="button" busy={busyAction === "load"} busyLabel="Loading..." disabled={busy && busyAction !== "load"} onClick={() => void loadInbox()}>
        Refresh inbox
      </LoadingButton>
      {error && <p className="form-message error" role="alert">{error}</p>}

      <h2 className={`${styles.attentionHeading} ${attentionStateClass}`}>{attentionHeading}</h2>
      {busy && flags.length === 0 ? (
        <div className={styles.list} role="status" aria-live="polite">
          <span className="sr-only">Loading items needing attention...</span>
          {Array.from({ length: 2 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
        </div>
      ) : flags.length === 0 ? (
        <div className="empty-state"><p>No blocked or failed agent actions to review.</p></div>
      ) : (
        <div className={styles.list}>
          {flags.map((flag) => <article className={styles.card} key={flag.id}>
            <header>
              <div>
                <p className="eyebrow">{flag.tool.replaceAll("_", " ")}</p>
                <time dateTime={flag.timestamp}>{formatSydneyDateTime(flag.timestamp)}</time>
              </div>
              <span className={styles.status}>{flag.outcome}</span>
            </header>
            <p className={styles.flagReason}>{flag.reason}</p>
          </article>)}
        </div>
      )}

      <h2>Pending approval <span>{pending.length}</span></h2>
      {busy && items.length === 0 ? (
        <div className={styles.list} role="status" aria-live="polite">
          <span className="sr-only">Loading pending approvals...</span>
          {Array.from({ length: 2 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
        </div>
      ) : pending.length === 0 ? (
        <div className="empty-state"><p>No pending approvals.</p></div>
      ) : (
        <div className={styles.list}>
          {pending.map((item) => <article className={`${styles.card}${collapsingId === item.id ? ` ${styles.cardCollapsing}` : ""}`} key={item.id}>
            <header>
              <div>
                <p className="eyebrow">{item.action.replaceAll("_", " ")}</p>
                <h3>{item.summary}</h3>
              </div>
              <span className={styles.status}>pending approval</span>
            </header>
            {editingId === item.id ? (
              <div className={styles.editForm}>
                <label>
                  Request summary
                  <input
                    maxLength={500}
                    value={summaries[item.id] ?? item.summary}
                    onChange={(event) => setSummaries((current) => ({
                      ...current,
                      [item.id]: event.target.value,
                    }))}
                  />
                </label>
                {Object.entries(item.details).map(([key, value]) => (
                  <label key={key}>
                    {key.replaceAll(/([A-Z])/g, " $1")}
                    {typeof value === "boolean" ? (
                      <select
                        value={details[item.id]?.[key] ?? String(value)}
                        onChange={(event) => setDetails((current) => ({
                          ...current,
                          [item.id]: { ...current[item.id], [key]: event.target.value },
                        }))}
                      >
                        <option value="true">Yes</option>
                        <option value="false">No</option>
                      </select>
                    ) : (
                      <input
                        maxLength={1000}
                        value={details[item.id]?.[key] ?? String(value ?? "")}
                        onChange={(event) => setDetails((current) => ({
                          ...current,
                          [item.id]: { ...current[item.id], [key]: event.target.value },
                        }))}
                      />
                    )}
                  </label>
                ))}
                <div className={styles.actions}>
                  <LoadingButton
                    type="button"
                    busy={busyAction === `save:${item.id}`}
                    busyLabel="Saving edits..."
                    success={successAction === `save:${item.id}`}
                    successLabel="Saved"
                    disabled={busy && busyAction !== `save:${item.id}`}
                    onClick={() => void saveEdit(item)}
                  >
                    Save edits
                  </LoadingButton>
                  <button type="button" disabled={busy} onClick={() => setEditingId("")}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <dl className={styles.details}>
                  {Object.entries(item.details).map(([key, value]) => (
                    <div key={key}><dt>{key.replaceAll("_", " ")}</dt><dd>{String(value ?? "Not provided")}</dd></div>
                  ))}
                </dl>
                <label className={styles.noteInput}>
                  Review note
                  <input
                    maxLength={500}
                    value={notes[item.id] ?? ""}
                    onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))}
                  />
                </label>
                <div className={styles.actions}>
                  <LoadingButton
                    type="button"
                    busy={busyAction === `approved:${item.id}`}
                    busyLabel="Approving..."
                    success={collapsingId === item.id && busyAction === `approved:${item.id}`}
                    successLabel="Approved"
                    disabled={busy && busyAction !== `approved:${item.id}`}
                    onClick={() => void decide(item, "approved")}
                  >
                    Approve
                  </LoadingButton>
                  <LoadingButton
                    type="button"
                    className="reject-button"
                    busy={busyAction === `rejected:${item.id}`}
                    busyLabel="Rejecting..."
                    success={collapsingId === item.id && busyAction === `rejected:${item.id}`}
                    successLabel="Rejected"
                    disabled={busy && busyAction !== `rejected:${item.id}`}
                    onClick={() => void decide(item, "rejected")}
                  >
                    Reject
                  </LoadingButton>
                  <button type="button" disabled={busy} onClick={() => setEditingId(item.id)}>Edit</button>
                </div>
              </>
            )}
          </article>)}
        </div>
      )}

      {reviewed.length > 0 && <>
        <h2>Reviewed</h2>
        <div className={styles.list}>
          {reviewed.map((item) => <article className={styles.card} key={item.id}>
            <header><h3>{item.summary}</h3><span className={styles.status}>{item.status}</span></header>
            {item.reviewerNote && <p>{item.reviewerNote}</p>}
            <time dateTime={item.reviewedAt ?? item.createdAt}>
              {formatSydneyDateTime(item.reviewedAt ?? item.createdAt)}
            </time>
          </article>)}
        </div>
      </>}
    </div>
  );
}
