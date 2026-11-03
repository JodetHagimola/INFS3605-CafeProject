"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { LoadingButton, Skeleton } from "../ui/feedback";
import styles from "./settings-panel.module.css";

const settingsResponseSchema = z.object({
  rules: z.array(z.object({
    id: z.string().uuid(),
    name: z.string(),
    enabled: z.boolean(),
    ingredient_ids: z.array(z.string().or(z.number()).transform(String)),
    supplier: z.string().nullable(),
    maximum_total: z.number().or(z.string()).transform(Number).nullable(),
    updated_at: z.string(),
  })),
  ingredients: z.array(z.object({
    ingredient_id: z.number().or(z.string()).transform(String),
    ingredient_name: z.string(),
    unit: z.string(),
  })),
  suppliers: z.array(z.string()),
}).strict();

type SettingsData = z.infer<typeof settingsResponseSchema>;
type StandingRule = SettingsData["rules"][number];

function sydneyDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function tomorrowSydney(): string {
  const today = sydneyDate(new Date());
  return new Date(Date.parse(`${today}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10);
}

function responseError(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  return "error" in payload && typeof payload.error === "string" ? payload.error : null;
}

export function SettingsPanel() {
  const router = useRouter();
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busyAction, setBusyAction] = useState("");
  const [successAction, setSuccessAction] = useState("");
  const [ruleId, setRuleId] = useState("");
  const [name, setName] = useState("");
  const [ingredientIds, setIngredientIds] = useState<string[]>([]);
  const [supplier, setSupplier] = useState("");
  const [maximumTotal, setMaximumTotal] = useState("");
  const [simulateDate, setSimulateDate] = useState("");

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/settings");
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "Agent settings could not be loaded.");
      const parsed = settingsResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The agent settings response was invalid.");
      setSettings(parsed.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Agent settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
    setSimulateDate(tomorrowSydney());
  }, []);

  function beginEdit(rule: StandingRule) {
    setRuleId(rule.id);
    setName(rule.name);
    setIngredientIds(rule.ingredient_ids);
    setSupplier(rule.supplier ?? "");
    setMaximumTotal(rule.maximum_total === null ? "" : String(rule.maximum_total));
  }

  function clearForm() {
    setRuleId("");
    setName("");
    setIngredientIds([]);
    setSupplier("");
    setMaximumTotal("");
  }

  async function saveRule(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setBusyAction("save");
    setSuccessAction("");
    setError("");
    try {
      const response = await fetch("/api/agent/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "save",
          ...(ruleId ? { id: ruleId } : {}),
          name,
          ingredientIds,
          supplier,
          maximumTotal: Number(maximumTotal),
        }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "The standing rule could not be saved.");
      clearForm();
      await loadSettings();
      setSuccessAction("save");
      window.setTimeout(() => setSuccessAction(""), 900);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "The standing rule could not be saved.");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  }

  async function toggleRule(rule: StandingRule) {
    setBusy(true);
    setBusyAction(`toggle:${rule.id}`);
    setSuccessAction("");
    setError("");
    try {
      const response = await fetch("/api/agent/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: "toggle", id: rule.id, enabled: !rule.enabled }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "The standing rule could not be updated.");
      await loadSettings();
      setSuccessAction(`toggle:${rule.id}`);
      window.setTimeout(() => setSuccessAction(""), 900);
    } catch (toggleError) {
      setError(toggleError instanceof Error ? toggleError.message : "The standing rule could not be updated.");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  }

  async function simulateDay() {
    setBusy(true);
    setBusyAction("simulate");
    setSuccessAction("");
    setError("");
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: true, date: simulateDate }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "The simulated brief could not be prepared.");
      setSuccessAction("simulate");
      window.dispatchEvent(new Event("brewlytics:navigation-start"));
      window.setTimeout(() => router.push(`/?date=${encodeURIComponent(simulateDate)}`), 240);
    } catch (simulateError) {
      setError(simulateError instanceof Error ? simulateError.message : "The simulated brief could not be prepared.");
    } finally {
      setBusy(false);
      setBusyAction("");
    }
  }

  return (
    <div className={styles.panel} aria-busy={busy || loading}>
      <section className={styles.card} aria-labelledby="session-title">
        <h2 id="session-title">Workspace access</h2>
        <p>You are signed in with a secure session. Sign out from the navigation when you are finished.</p>
      </section>

      <section className={styles.card} aria-labelledby="approval-rules-title">
        <h2 id="approval-rules-title">Standing approval rules</h2>
        <p>
          A rule can automatically record approval for a saved draft only when every ingredient,
          the supplier, and the total are within its limits. Brewlytics never sends an order or contacts a supplier.
        </p>
        {loading && !settings && <div className="loading-cards" role="status" aria-live="polite">
          <span className="sr-only">Loading agent settings...</span>
          {Array.from({ length: 2 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
        </div>}
        {settings?.rules.map((rule) => (
          <article className={styles.rule} key={rule.id}>
            <div>
              <h3>{rule.name}</h3>
              <p>
                {rule.ingredient_ids.map((id) =>
                  settings.ingredients.find((ingredient) => ingredient.ingredient_id === id)?.ingredient_name ?? id)
                  .join(", ")} · {rule.supplier ?? "No supplier"} · up to ${rule.maximum_total ?? "—"}
              </p>
              <p>{rule.enabled ? "Enabled" : "Paused"}</p>
            </div>
            <div className={styles.ruleActions}>
              <button type="button" disabled={busy} onClick={() => beginEdit(rule)}>Edit</button>
              <LoadingButton
                type="button"
                busy={busyAction === `toggle:${rule.id}`}
                busyLabel="Updating..."
                success={successAction === `toggle:${rule.id}`}
                successLabel="Updated"
                disabled={busy && busyAction !== `toggle:${rule.id}`}
                onClick={() => void toggleRule(rule)}
              >
                {rule.enabled ? "Pause" : "Enable"}
              </LoadingButton>
            </div>
          </article>
        ))}
        {settings && settings.rules.length === 0 && <div className="empty-state"><p>Nothing here yet. Add a rule when you&apos;re ready.</p></div>}

        <form className={styles.form} onSubmit={saveRule}>
          <h3>{ruleId ? "Edit rule" : "Add a rule"}</h3>
          <label className={styles.field}>
            Rule name
            <input maxLength={160} required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className={styles.ingredients}>
            <legend>Ingredients covered</legend>
            {settings?.ingredients.map((ingredient) => (
              <label key={ingredient.ingredient_id}>
                <input
                  type="checkbox"
                  checked={ingredientIds.includes(ingredient.ingredient_id)}
                  onChange={(event) => setIngredientIds((current) => event.target.checked
                    ? [...current, ingredient.ingredient_id]
                    : current.filter((id) => id !== ingredient.ingredient_id))}
                />
                {ingredient.ingredient_name} ({ingredient.unit})
              </label>
            ))}
          </fieldset>
          <label className={styles.field}>
            Supplier
            <select required value={supplier} onChange={(event) => setSupplier(event.target.value)}>
              <option value="">Choose a listed supplier</option>
              {settings?.suppliers.map((nameValue) => <option key={nameValue} value={nameValue}>{nameValue}</option>)}
            </select>
          </label>
          <label className={styles.field}>
            Maximum draft total ($)
            <input
              type="number"
              min="0.01"
              step="0.01"
              required
              value={maximumTotal}
              onChange={(event) => setMaximumTotal(event.target.value)}
            />
          </label>
          <div className={styles.ruleActions}>
            <LoadingButton
              type="submit"
              busy={busyAction === "save"}
              busyLabel="Saving..."
              success={successAction === "save"}
              successLabel="Saved"
              disabled={!settings || (busy && busyAction !== "save")}
            >
              {ruleId ? "Save rule" : "Add rule"}
            </LoadingButton>
            {ruleId && <button type="button" disabled={busy} onClick={clearForm}>Cancel edit</button>}
          </div>
        </form>
      </section>

      <section className={styles.card} aria-labelledby="simulate-day-title">
        <h2 id="simulate-day-title">Demo a different day</h2>
        <p>Generate and open a fresh brief for the selected date without changing today&apos;s brief.</p>
        <label className={styles.field}>
          Brief date
          <input type="date" required value={simulateDate} onChange={(event) => setSimulateDate(event.target.value)} />
        </label>
        <LoadingButton
          className="primary-button"
          type="button"
          busy={busyAction === "simulate"}
          busyLabel="Preparing..."
          success={successAction === "simulate"}
          successLabel="Ready"
          disabled={busy && busyAction !== "simulate" || !simulateDate}
          onClick={() => void simulateDay()}
        >
          Simulate a new day
        </LoadingButton>
      </section>

      {error && <p className="form-message error" role="alert">{error}</p>}
    </div>
  );
}
