"use client";

import { useRef, useState } from "react";
import { LoadingButton } from "../ui/feedback";
import styles from "./login-screen.module.css";

export function LoginScreen() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [shaking, setShaking] = useState(false);
  const passcodeInput = useRef<HTMLInputElement>(null);

  async function login(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setSuccess(false);
    setShaking(false);
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
      setSuccess(true);
      await new Promise((resolve) => window.setTimeout(resolve, 240));
      window.location.assign("/");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : "Could not sign in.");
      setShaking(true);
      passcodeInput.current?.focus({ preventScroll: true });
      window.setTimeout(() => setShaking(false), 350);
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
        <form onSubmit={login} aria-busy={busy}>
          <label htmlFor="agent-passcode">Passcode</label>
          <input
            ref={passcodeInput}
            id="agent-passcode"
            className={shaking ? styles.shaking : undefined}
            type="password"
            autoComplete="current-password"
            maxLength={128}
            required
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
          />
          {error && <p className={styles.error} role="alert">{error}</p>}
          {success && <p className={styles.success} role="status" aria-live="polite"><span aria-hidden="true">✓</span> Welcome back</p>}
          <LoadingButton className="primary-button" type="submit" busy={busy} busyLabel="Checking..." success={success} successLabel="Ready">
            Continue
          </LoadingButton>
        </form>
      </section>
    </main>
  );
}
