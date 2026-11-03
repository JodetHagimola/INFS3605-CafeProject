"use client";

import { useState } from "react";
import { draftOrderSchema, type DraftOrderRecord } from "@/lib/agent/draft-schema";
import styles from "./chat-panel.module.css";

type Message = {
  id: number;
  role: "owner" | "agent";
  text: string;
  draft?: DraftOrderRecord | null;
};

function responseError(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return "error" in value && typeof value.error === "string" ? value.error : null;
}

export function ChatPanel() {
  const [passcode, setPasscode] = useState("");
  const [requestText, setRequestText] = useState("");
  const [forecastDate, setForecastDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [isPublicHoliday, setIsPublicHoliday] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function sendMessage(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    const request = requestText.trim();
    try {
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode, request, forecastDate, isPublicHoliday }),
      });
      let payload: unknown;
      try {
        payload = await response.json();
      } catch {
        throw new Error("The server returned an invalid response.");
      }
      if (!response.ok) {
        throw new Error(responseError(payload) ?? "The agent could not complete the request.");
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)
        || !("answer" in payload) || typeof payload.answer !== "string"
        || !("draft" in payload)) {
        throw new Error("The server returned an invalid agent response.");
      }
      const answer = payload.answer;
      const draft = payload.draft === null ? null : draftOrderSchema.parse(payload.draft);
      setMessages((current) => [
        ...current,
        { id: Date.now(), role: "owner", text: request },
        { id: Date.now() + 1, role: "agent", text: answer, draft },
      ]);
      setRequestText("");
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "The agent could not complete the request.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.chat}>
      <form className={styles.credentials} onSubmit={(event) => event.preventDefault()}>
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
        <label className={styles.holiday}>
          <input
            type="checkbox"
            checked={isPublicHoliday}
            onChange={(event) => setIsPublicHoliday(event.target.checked)}
          />
          Selected date is a public holiday
        </label>
      </form>

      <p className={styles.note}>
        The passcode stays in this page&apos;s memory and is sent only to the server
        with each request. Forecasts are indicative AI estimates and may use synthetic history.
      </p>

      <div className={styles.messages} aria-live="polite">
        {messages.length === 0
          ? <p className={styles.empty}>Try: “What do I need for the long weekend?”</p>
          : messages.map((message) => (
            <article
              className={message.role === "owner" ? styles.ownerMessage : styles.agentMessage}
              key={message.id}
            >
              <p className={styles.speaker}>{message.role === "owner" ? "You" : "Brewlytics"}</p>
              <p className={styles.messageText}>{message.text}</p>
              {message.draft && <section className={styles.draft} aria-label="Saved draft order">
                <h2>Draft order · {message.draft.status}</h2>
                <p>Forecast date: {message.draft.forecastDate}</p>
                {message.draft.flags.length > 0 && <ul>
                  {message.draft.flags.map((flag) => <li key={flag}>{flag}</li>)}
                </ul>}
                <div className={styles.tableWrap}>
                  <table>
                    <thead><tr><th>Ingredient</th><th>Required</th><th>In stock</th><th>Incoming</th><th>Draft quantity</th><th>Supplier</th></tr></thead>
                    <tbody>{message.draft.lines.length
                      ? message.draft.lines.map((line) => <tr key={line.ingredientId}>
                        <td>{line.ingredient}</td>
                        <td>{line.requiredQuantity} {line.unit}</td>
                        <td>{line.currentStock} {line.unit}</td>
                        <td>{line.incomingStock} {line.unit}</td>
                        <td>{line.recommendedOrderQuantity} {line.unit}</td>
                        <td>{line.recommendedSupplier.supplier}</td>
                      </tr>)
                      : <tr><td colSpan={6}>No ingredients need replenishment for this forecast.</td></tr>}
                    </tbody>
                  </table>
                </div>
              </section>}
            </article>
          ))}
      </div>

      {error && <p className={styles.error} role="alert">{error}</p>}
      <form className={styles.composer} onSubmit={sendMessage}>
        <label htmlFor="agent-message">Message</label>
        <textarea
          id="agent-message"
          required
          maxLength={1000}
          rows={3}
          value={requestText}
          onChange={(event) => setRequestText(event.target.value)}
          placeholder="What do I need for the long weekend?"
        />
        <button className="primary-button" type="submit" disabled={busy || !passcode}>
          {busy ? "Thinking..." : "Ask the agent"}
        </button>
      </form>
    </div>
  );
}
