"use client";

import { useState } from "react";
import type { DraftOrder } from "@/lib/agent/server";
import styles from "./agent-panel.module.css";

type AgentPanelProps = {
  initialDraft: DraftOrder | null;
};

type AgentResponse = {
  answer?: string;
  draft?: DraftOrder | null;
  error?: string;
};

async function readAgentResponse(response: Response): Promise<AgentResponse> {
  if (response.status === 504) {
    throw new Error("The agent took too long to respond. Please try again.");
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw new Error("The server returned an invalid response. Please try again.");
  }

  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("The server returned an invalid response. Please try again.");
  }
  return result as AgentResponse;
}

export function AgentPanel({ initialDraft }: AgentPanelProps) {
  const [passcode, setPasscode] = useState("");
  const [requestText, setRequestText] = useState("Check what ingredients need replenishing.");
  const [forecastDate, setForecastDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isPublicHoliday, setIsPublicHoliday] = useState(false);
  const [draft, setDraft] = useState(initialDraft);
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function runAgent(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setAnswer("");

    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode, request: requestText, forecastDate, isPublicHoliday }),
      });
      const result = await readAgentResponse(response);
      if (!response.ok) throw new Error(result.error || "The agent could not complete the request.");
      setDraft(result.draft ?? null);
      setAnswer(result.answer || "The agent finished without a text response.");
    } catch (requestError) {
      setError(requestError instanceof Error
        ? requestError.message
        : "The AI request failed. Check the server settings and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function approveDraft() {
    if (!draft || draft.status !== "draft") return;
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/agent/approve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode, draftId: draft.id }),
      });
      const result = await readAgentResponse(response);
      if (!response.ok) throw new Error(result.error || "The draft could not be approved.");
      setDraft({ ...draft, status: "approved" });
    } catch (approvalError) {
      setError(approvalError instanceof Error
        ? approvalError.message
        : "The draft could not be approved. Check the passcode and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <form className={styles.form} onSubmit={runAgent}>
        <label>
          Agent passcode
          <input
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
          />
        </label>
        <label>
          Forecast date
          <input
            type="date"
            required
            value={forecastDate}
            onChange={(event) => setForecastDate(event.target.value)}
          />
        </label>
        <label className={styles.checkbox}>
          <input
            type="checkbox"
            checked={isPublicHoliday}
            onChange={(event) => setIsPublicHoliday(event.target.checked)}
          />
          This date is a public holiday
        </label>
        <label className={styles.fullWidth}>
          What would you like the agent to check?
          <textarea
            maxLength={1000}
            required
            rows={3}
            value={requestText}
            onChange={(event) => setRequestText(event.target.value)}
          />
        </label>
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "Working..." : "Create a draft"}
        </button>
      </form>

      <p className={styles.note}>
        The passcode is checked on the server and is not saved. Your AI and
        Supabase secret keys stay on the server. Select the holiday box only
        when you have checked the café&apos;s holiday calendar.
      </p>

      {error && <p className={styles.error} role="alert">{error}</p>}
      {answer && <section className={styles.answer} aria-live="polite">
        <h2>Agent response</h2>
        <p>{answer}</p>
      </section>}

      {draft && <section className={styles.draft} aria-labelledby="draft-title">
        <div className={styles.draftHeading}>
          <div>
            <p className="eyebrow">Saved draft · {draft.forecastDate}</p>
            <h2 id="draft-title">Replenishment order</h2>
          </div>
          <span className={styles.status}>{draft.status}</span>
        </div>

        {draft.flags.length > 0 && <div className={styles.flags} role="note">
          <strong>Review these notes before deciding:</strong>
          <ul>{draft.flags.map((flag) => <li key={flag}>{flag}</li>)}</ul>
        </div>}

        <h3>Forecasted drink sales</h3>
        <p>
          {Object.entries(draft.forecast.predictedSales)
            .map(([product, quantity]) => `${product}: ${quantity}`)
            .join(" · ")}
        </p>
        <p className={styles.muted}>
          {draft.forecast.source}. Treat these predictions as indicative only.
        </p>

        <div className={styles.tableWrap}>
          <table>
            <thead>
              <tr>
                <th>Ingredient</th>
                <th>Required</th>
                <th>In stock</th>
                <th>Incoming</th>
                <th>Order draft</th>
                <th>Supplier and alternative</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {draft.lines.length === 0
                ? <tr><td colSpan={7}>No ingredients need replenishment for this forecast.</td></tr>
                : draft.lines.map((line) => <tr key={line.ingredientId}>
                  <td>{line.ingredient}</td>
                  <td>{line.requiredQuantity} {line.unit}</td>
                  <td>{line.currentStock} {line.unit}</td>
                  <td>{line.incomingStock} {line.unit}</td>
                  <td>{line.recommendedOrderQuantity} {line.unit}</td>
                  <td>
                    <strong>{line.recommendedSupplier.supplier}</strong>
                    {" — price "}{line.recommendedSupplier.price}
                    {" · "}{line.recommendedSupplier.deliveryTime}
                    {line.alternativeSupplier && <p className={styles.muted}>
                      Alternative: {line.alternativeSupplier.supplier}
                      {" — price "}{line.alternativeSupplier.price}
                      {" · "}{line.alternativeSupplier.deliveryTime}
                    </p>}
                  </td>
                  <td>{line.reason}</td>
                </tr>)}
            </tbody>
          </table>
        </div>

        <details className={styles.sourceDetails}>
          <summary>Show the permitted data used</summary>
          <pre>{JSON.stringify(draft.dataUsed, null, 2)}</pre>
        </details>

        {draft.status === "draft"
          ? <div className={styles.approval}>
            <p>
              Review quantities, suppliers, alternatives, and flags. Approving
              records your decision only; it does not send an order.
            </p>
            <button className="primary-button" type="button" disabled={busy || !passcode} onClick={approveDraft}>
              Approve this draft
            </button>
          </div>
          : <p className={styles.approved}>You approved this draft. No supplier was contacted.</p>}
      </section>}
    </div>
  );
}
