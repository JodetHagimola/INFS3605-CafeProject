"use client";

import { useState } from "react";
import styles from "./login-screen.module.css";

export function LoginScreen() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const message = typeof result === "object" && result !== null
          && "error" in result && typeof result.error === "string"
          ? result.error
          : "Could not sign in.";
        throw new Error(message);
      }

      setPasscode("");
      window.location.assign("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.screen}>
      <section className={styles.card} aria-labelledby="login-title">
        <p className={styles.eyebrow}>BREWLYTICS</p>
        <h1 id="login-title">Your café, in good hands.</h1>
        <p>Enter the shared passcode to open your workspace.</p>
        <form onSubmit={login}>
          <label htmlFor="agent-passcode">Passcode</label>
          <input
            id="agent-passcode"
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
          />
          {error && <p className={styles.error} role="alert">{error}</p>}
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? "Unlocking..." : "Continue"}
          </button>
        </form>
      </section>
    </main>
  );
}
