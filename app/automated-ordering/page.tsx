
"use client";

import { useState } from "react";

export default function AutomatedOrderingPage() {
  const [recommendations, setRecommendations] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function generateRecommendations() {
    setLoading(true);
    setError("");

    try {
      const response = await fetch("/api/recommendations");

      if (!response.ok) {
        throw new Error("Could not connect to the Python API");
      }

      const data = await response.json();

      if (data.status !== "success") {
        throw new Error(data.message || "Prediction failed");
      }

      setRecommendations(data.recommendations);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong"
      );
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="wordmark" href="/" aria-label="Cafe Inventory home">
          <span className="wordmark-mark" aria-hidden="true">C</span>
          <span>Cafe Inventory</span>
        </a>
        <nav className="topbar-nav" aria-label="Main navigation">
          <a href="/">Orders</a>
          <a href="/inventory">Inventory</a>
          <a href="/automated-ordering" aria-current="page">AI Forecast</a>
          <a href="/order-requests">Order requests</a>
        </nav>
      </header>
      <section className="orders-section" aria-labelledby="automated-ordering-title">
        <h1 id="automated-ordering-title">AI Automated Ordering</h1>

        <p className="section-description" style={{ marginBottom: "24px" }}>
          Generate ingredient order recommendations using AI sales
          forecasts and current inventory levels.
        </p>

        <button
          className="primary-button"
          onClick={generateRecommendations}
          disabled={loading}
        >
          {loading ? "Generating..." : "Generate Recommendations"}
        </button>

        {error && (
          <p className="form-message error" role="alert">
            Error: {error}
          </p>
        )}

        {recommendations && (
          <pre className="recommendations">{recommendations}</pre>
        )}
      </section>
    </main>
  );
}
