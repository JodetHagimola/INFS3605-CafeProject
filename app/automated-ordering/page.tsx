
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
    <main style={{ padding: "40px", maxWidth: "900px", margin: "auto" }}>
      <h1 style={{ fontSize: "28px", fontWeight: "bold" }}>
        AI Automated Ordering
      </h1>

      <p style={{ marginTop: "12px", marginBottom: "24px" }}>
        Generate ingredient order recommendations using AI sales
        forecasts and current inventory levels.
      </p>

      <button
        onClick={generateRecommendations}
        disabled={loading}
        style={{
          backgroundColor: "#2563eb",
          color: "white",
          padding: "12px 20px",
          borderRadius: "8px",
          cursor: "pointer",
        }}
      >
        {loading ? "Generating..." : "Generate Recommendations"}
      </button>

      {error && (
        <p style={{ color: "red", marginTop: "20px" }}>
          Error: {error}
        </p>
      )}

      {recommendations && (
        <pre
          style={{
            marginTop: "30px",
            padding: "20px",
            backgroundColor: "#f3f4f6",
            borderRadius: "8px",
            whiteSpace: "pre-wrap",
            color: "#111827",
          }}
        >
          {recommendations}
        </pre>
      )}
    </main>
  );
}
