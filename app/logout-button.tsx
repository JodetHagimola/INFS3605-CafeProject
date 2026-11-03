"use client";

import { useState } from "react";
import { LoadingButton } from "./ui/feedback";

export function LogoutButton() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function logout() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not log out. Please try again.");
      window.location.assign("/");
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Could not log out. Please try again.");
      setBusy(false);
    }
  }

  return (
    <>
      <LoadingButton className="nav-logout" type="button" busy={busy} busyLabel="Signing out..." onClick={() => void logout()}>
        Log out
      </LoadingButton>
      {error && <span className="nav-logout-error" role="alert">{error}</span>}
    </>
  );
}
