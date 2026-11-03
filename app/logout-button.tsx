"use client";

import { useState } from "react";

export function LogoutButton() {
  const [error, setError] = useState("");

  async function logout() {
    setError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) throw new Error("Could not log out. Please try again.");
      window.location.assign("/");
    } catch (logoutError) {
      setError(logoutError instanceof Error ? logoutError.message : "Could not log out. Please try again.");
    }
  }

  return (
    <>
      <button className="nav-logout" type="button" onClick={() => void logout()}>
        Log out
      </button>
      {error && <span className="nav-logout-error" role="alert">{error}</span>}
    </>
  );
}
