"use client";

import { useState } from "react";
import type { AgentActivity } from "@/lib/agent/activity-log";
import styles from "./activity-panel.module.css";

type ActivityResponse = { items?: AgentActivity[]; error?: string };

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
  const [passcode, setPasscode] = useState("");
  const [items, setItems] = useState<AgentActivity[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function load(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/agent/activity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const result = await response.json() as ActivityResponse;
      if (!response.ok) throw new Error(result.error || "Activity could not be loaded.");
      setItems(result.items ?? []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Activity could not be loaded.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <form className={styles.passcodeForm} onSubmit={load}>
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
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "Loading..." : "Load activity"}
        </button>
      </form>
      <p className={styles.note}>The passcode is checked on the server and is not stored here.</p>
      {error && <p className="form-message error" role="alert">{error}</p>}
      {items.length === 0 ? (
        <div className="empty-state"><p>No activity to show yet.</p></div>
      ) : (
        <div className={styles.list}>
          {items.map((item) => <article className={styles.card} key={item.id}>
            <header>
              <div>
                <p className="eyebrow">{item.tool.replaceAll("_", " ")}</p>
                <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time>
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
    </div>
  );
}
