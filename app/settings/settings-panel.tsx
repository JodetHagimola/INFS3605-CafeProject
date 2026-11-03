"use client";

import { useState } from "react";
import styles from "./settings-panel.module.css";

export function SettingsPanel() {
  const [passcode, setPasscode] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function verify(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setStatus("");
    setError("");
    try {
      const response = await fetch("/api/agent/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode, operation: "verify" }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : "The passcode could not be verified.";
        throw new Error(message);
      }
      setStatus("Passcode verified. It is not stored by this page.");
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : "The passcode could not be verified.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.panel}>
      <section className={styles.card} aria-labelledby="passcode-title">
        <h2 id="passcode-title">Agent passcode</h2>
        <form onSubmit={verify}>
          <label>
            Shared passcode
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
            {busy ? "Checking..." : "Verify passcode"}
          </button>
        </form>
        {status && <p className={styles.success} role="status">{status}</p>}
        {error && <p className="form-message error" role="alert">{error}</p>}
        <p className={styles.note}>The passcode is sent only to server endpoints when entered and is not saved in browser storage.</p>
      </section>

      <section className={styles.card} aria-labelledby="approval-rules-title">
        <h2 id="approval-rules-title">Approval rules</h2>
        <p>No standing auto-approval rules are enabled. Any purchase, supplier contact or price change must be reviewed in the Inbox.</p>
        <p>Approving an inbox item records a human decision only. Brewlytics does not send an order or contact a supplier.</p>
      </section>
    </div>
  );
}
