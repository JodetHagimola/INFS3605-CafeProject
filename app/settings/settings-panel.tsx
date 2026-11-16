"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { LoadingButton, Skeleton } from "../ui/feedback";
import styles from "./settings-panel.module.css";

const responseSchema = z.object({
  profile: z.object({
    cafeName: z.string(),
    ownerName: z.string(),
    ownerEmail: z.string(),
    openTime: z.string(),
    closeTime: z.string(),
    rushWindows: z.array(z.object({ start: z.string(), end: z.string() }).strict()),
    emailMode: z.string(),
    automationPaused: z.boolean(),
  }).strict(),
  policy: z.object({
    autoOrderLimit: z.string().nullable(),
    dailyLimit: z.string().nullable(),
    weeklyLimit: z.string().nullable(),
  }).strict(),
  suppliers: z.array(z.object({
    name: z.string(),
    contactEmail: z.string(),
    leadTimeDays: z.number(),
    orderCutoff: z.string(),
    deliveryWindowStart: z.string(),
    deliveryWindowEnd: z.string(),
    active: z.boolean(),
  }).strict()),
  ingredients: z.array(z.object({
    id: z.string(),
    name: z.string(),
    unit: z.string(),
    minimumStock: z.string().nullable(),
    autoThreshold: z.boolean(),
    offers: z.array(z.object({
      supplier: z.string(),
      price: z.string().nullable(),
      minimumOrder: z.string().nullable(),
      packSize: z.string().nullable(),
      packLabel: z.string().nullable(),
      leadTimeDays: z.number().nullable(),
    }).strict()),
    rule: z.object({
      supplier: z.string(),
      packs: z.number(),
      orderLimit: z.string().nullable(),
      enabled: z.boolean(),
    }).strict().nullable(),
  }).strict()),
  legacyRules: z.array(z.object({
    name: z.string(),
    supplier: z.string().nullable(),
    maximumTotal: z.string().nullable(),
    enabled: z.boolean(),
  }).strict()),
}).strict();

type SettingsData = z.infer<typeof responseSchema>;
type IngredientRule = SettingsData["ingredients"][number];
type Supplier = SettingsData["suppliers"][number];

function responseError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  return "error" in payload && typeof payload.error === "string" ? payload.error : null;
}

async function postSettings(body: Record<string, unknown>): Promise<void> {
  const response = await fetch("/api/agent/settings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("The settings response was invalid.");
  }
  if (!response.ok) throw new Error(responseError(payload) ?? "Settings could not be saved.");
}

function useSave(onSaved: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function saveRequest(request: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setMessage("");
    setError("");
    try {
      await request();
      await onSaved();
      setMessage("Saved.");
      window.setTimeout(() => setMessage(""), 1200);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Settings could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, message, error, saveRequest };
}

function priceLabel(price: string | null, unit: string): string {
  if (price === null) return "Price unavailable";
  const amount = Number(price);
  if (!Number.isFinite(amount)) return "Price unavailable";
  const displayAmount = unit === "ml" || unit === "g" ? amount * 1000 : amount;
  const displayUnit = unit === "ml" ? "L" : unit === "g" ? "kg" : unit;
  return `${new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    maximumFractionDigits: 2,
  }).format(displayAmount)} per ${displayUnit}`;
}

function PolicyForm({
  policy,
  paused,
  onSaved,
}: {
  policy: SettingsData["policy"];
  paused: boolean;
  onSaved: () => Promise<void>;
}) {
  const { busy, message, error, saveRequest } = useSave(onSaved);
  const [autoOrderLimit, setAutoOrderLimit] = useState(policy.autoOrderLimit ?? "");
  const [dailyLimit, setDailyLimit] = useState(policy.dailyLimit ?? "");
  const [weeklyLimit, setWeeklyLimit] = useState(policy.weeklyLimit ?? "");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveRequest(() => postSettings({
      operation: "save-policy",
      autoOrderLimit: Number(autoOrderLimit),
      dailyLimit: Number(dailyLimit),
      weeklyLimit: weeklyLimit.trim() ? Number(weeklyLimit) : null,
    }));
  }

  return (
    <div className={styles.card}>
      <h3>Spend limits</h3>
      <p>These caps and the per-ingredient rules below are the single source of truth for automated ordering.</p>
      <form className={styles.form} onSubmit={submit} aria-busy={busy}>
        <div className={styles.fieldGrid}>
          <label>Automatic order limit (AUD)
            <input type="number" min="0.01" max="1000000" step="0.01" required
              value={autoOrderLimit} onChange={(event) => setAutoOrderLimit(event.target.value)} />
          </label>
          <label>Daily spend cap (AUD)
            <input type="number" min="0.01" max="1000000" step="0.01" required
              value={dailyLimit} onChange={(event) => setDailyLimit(event.target.value)} />
          </label>
          <label>Weekly spend cap (AUD, optional)
            <input type="number" min="0.01" max="1000000" step="0.01"
              value={weeklyLimit} onChange={(event) => setWeeklyLimit(event.target.value)} />
          </label>
        </div>
        <div className={styles.actions}>
          <LoadingButton type="submit" className="primary-button" busy={busy} busyLabel="Saving..." success={Boolean(message)} successLabel="Saved">
            Save spend limits
          </LoadingButton>
          <PauseButton paused={paused} onSaved={onSaved} />
        </div>
        {message && <p className={styles.success} role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </div>
  );
}

function PauseButton({ paused, onSaved }: { paused: boolean; onSaved: () => Promise<void> }) {
  const { busy, message, error, saveRequest } = useSave(onSaved);
  return (
    <div className={styles.pauseControl}>
      <p>{paused ? "Automation is paused. Brewly observes and drafts only." : "Automation is active within the configured policy."}</p>
      <LoadingButton
        type="button"
        className="secondary-button"
        busy={busy}
        busyLabel="Updating..."
        success={Boolean(message)}
        successLabel="Updated"
        onClick={() => void saveRequest(() => postSettings({ operation: "set-pause", paused: !paused }))}
      >
        {paused ? "Resume automation" : "Pause automation"}
      </LoadingButton>
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}

function ReorderRuleForm({
  ingredient,
  onSaved,
}: {
  ingredient: IngredientRule;
  onSaved: () => Promise<void>;
}) {
  const { busy, message, error, saveRequest } = useSave(onSaved);
  const [supplier, setSupplier] = useState(ingredient.rule?.supplier ?? ingredient.offers[0]?.supplier ?? "");
  const [packs, setPacks] = useState(String(ingredient.rule?.packs ?? 1));
  const [orderLimit, setOrderLimit] = useState(ingredient.rule?.orderLimit ?? "");
  const [enabled, setEnabled] = useState(ingredient.rule?.enabled ?? false);
  const offer = ingredient.offers.find((item) => item.supplier === supplier);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveRequest(() => postSettings({
      operation: "save-reorder-rule",
      ingredientId: ingredient.id,
      supplier,
      packs: Number(packs),
      orderLimit: Number(orderLimit),
      enabled,
    }));
  }

  return (
    <form className={styles.ruleForm} onSubmit={submit} aria-busy={busy}>
      <div>
        <h4>{ingredient.name} <span>({ingredient.unit})</span></h4>
        <p>Current minimum: {ingredient.minimumStock ?? "not set"} {ingredient.minimumStock ? ingredient.unit : ""}
          {ingredient.autoThreshold ? " · recalculated automatically" : ""}</p>
      </div>
      {!ingredient.offers.length ? (
        <p className={styles.notice}>No listed supplier price is available; automated ordering stays off.</p>
      ) : (
        <>
          <label>Preferred supplier
            <select required value={supplier} onChange={(event) => {
              const nextSupplier = event.target.value;
              setSupplier(nextSupplier);
              const nextRule = ingredient.offers.find((item) => item.supplier === nextSupplier);
              if (!orderLimit && nextRule?.price) setOrderLimit("50");
            }}>
              {ingredient.offers.map((item) => (
                <option key={item.supplier} value={item.supplier}>{item.supplier}</option>
              ))}
            </select>
          </label>
          {offer && <p className={styles.muted}>
            {priceLabel(offer.price, ingredient.unit)}
            {offer.packLabel ? ` · ${offer.packLabel}` : ""}
            {offer.minimumOrder ? ` · minimum ${offer.minimumOrder} ${ingredient.unit}` : ""}
          </p>}
          <div className={styles.fieldGrid}>
            <label>Normal quantity (packs)
              <input type="number" min="1" max="10000" step="1" required
                value={packs} onChange={(event) => setPacks(event.target.value)} />
            </label>
            <label>Per-order cap (AUD)
              <input type="number" min="0.01" max="1000000" step="0.01" required
                value={orderLimit} onChange={(event) => setOrderLimit(event.target.value)} />
            </label>
          </div>
          <label className={styles.check}>
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            Allow automatic ordering for this ingredient within all spend limits
          </label>
          <LoadingButton type="submit" className="secondary-button" busy={busy} busyLabel="Saving..." success={Boolean(message)} successLabel="Saved">
            Save reorder rule
          </LoadingButton>
        </>
      )}
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

function ProfileForm({
  profile,
  onSaved,
}: {
  profile: SettingsData["profile"];
  onSaved: () => Promise<void>;
}) {
  const { busy, message, error, saveRequest } = useSave(onSaved);
  const [cafeName, setCafeName] = useState(profile.cafeName);
  const [ownerName, setOwnerName] = useState(profile.ownerName);
  const [ownerEmail, setOwnerEmail] = useState(profile.ownerEmail);
  const [openTime, setOpenTime] = useState(profile.openTime);
  const [closeTime, setCloseTime] = useState(profile.closeTime);
  const [rushWindows, setRushWindows] = useState(profile.rushWindows);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveRequest(() => postSettings({
      operation: "save-profile",
      cafeName,
      ownerName,
      ownerEmail,
      openTime,
      closeTime,
      rushWindows,
    }));
  }

  return (
    <form className={styles.card} onSubmit={submit} aria-busy={busy}>
      <h3>Café profile</h3>
      <p>Hours and rush windows use Australia/Sydney time.</p>
      <div className={styles.fieldGrid}>
        <label>Café name
          <input required maxLength={120} value={cafeName} onChange={(event) => setCafeName(event.target.value)} />
        </label>
        <label>Owner name
          <input maxLength={120} value={ownerName} onChange={(event) => setOwnerName(event.target.value)} />
        </label>
        <label>Owner email
          <input type="email" maxLength={254} value={ownerEmail} onChange={(event) => setOwnerEmail(event.target.value)} />
        </label>
        <label>Opens
          <input type="time" required value={openTime} onChange={(event) => setOpenTime(event.target.value)} />
        </label>
        <label>Closes
          <input type="time" required value={closeTime} onChange={(event) => setCloseTime(event.target.value)} />
        </label>
      </div>
      <fieldset className={styles.windows}>
        <legend>Rush windows</legend>
        {rushWindows.map((window, index) => (
          <div className={styles.windowRow} key={`${index}-${window.start}-${window.end}`}>
            <label>Starts
              <input type="time" value={window.start} onChange={(event) => setRushWindows((current) =>
                current.map((item, row) => row === index ? { ...item, start: event.target.value } : item))} />
            </label>
            <label>Ends
              <input type="time" value={window.end} onChange={(event) => setRushWindows((current) =>
                current.map((item, row) => row === index ? { ...item, end: event.target.value } : item))} />
            </label>
            <button type="button" className="secondary-button" disabled={busy}
              onClick={() => setRushWindows((current) => current.filter((_, row) => row !== index))}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="secondary-button" disabled={busy || rushWindows.length >= 8}
          onClick={() => setRushWindows((current) => [...current, { start: "12:00", end: "13:00" }])}>
          Add rush window
        </button>
      </fieldset>
      <p className={styles.muted}>Supplier email mode: <strong>{profile.emailMode}</strong>. This app currently queues test-mode messages only.</p>
      <div className={styles.actions}>
        <LoadingButton type="submit" className="primary-button" busy={busy} busyLabel="Saving..." success={Boolean(message)} successLabel="Saved">
          Save café profile
        </LoadingButton>
      </div>
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

function SupplierForm({ supplier, onSaved }: { supplier: Supplier; onSaved: () => Promise<void> }) {
  const { busy, message, error, saveRequest } = useSave(onSaved);
  const [contactEmail, setContactEmail] = useState(supplier.contactEmail);
  const [leadTimeDays, setLeadTimeDays] = useState(String(supplier.leadTimeDays));
  const [orderCutoff, setOrderCutoff] = useState(supplier.orderCutoff);
  const [deliveryWindowStart, setDeliveryWindowStart] = useState(supplier.deliveryWindowStart);
  const [deliveryWindowEnd, setDeliveryWindowEnd] = useState(supplier.deliveryWindowEnd);
  const [active, setActive] = useState(supplier.active);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void saveRequest(() => postSettings({
      operation: "save-supplier",
      name: supplier.name,
      contactEmail,
      leadTimeDays: Number(leadTimeDays),
      orderCutoff,
      deliveryWindowStart,
      deliveryWindowEnd,
      active,
    }));
  }

  return (
    <form className={styles.supplierForm} onSubmit={submit} aria-busy={busy}>
      <h3>{supplier.name}</h3>
      <div className={styles.fieldGrid}>
        <label>Contact email
          <input type="email" maxLength={254} value={contactEmail}
            onChange={(event) => setContactEmail(event.target.value)} />
        </label>
        <label>Lead time (days)
          <input type="number" min="0" max="365" step="1" required value={leadTimeDays}
            onChange={(event) => setLeadTimeDays(event.target.value)} />
        </label>
        <label>Order cutoff (Sydney time)
          <input type="time" value={orderCutoff} onChange={(event) => setOrderCutoff(event.target.value)} />
        </label>
        <label>Delivery window starts
          <input type="time" value={deliveryWindowStart} onChange={(event) => setDeliveryWindowStart(event.target.value)} />
        </label>
        <label>Delivery window ends
          <input type="time" value={deliveryWindowEnd} onChange={(event) => setDeliveryWindowEnd(event.target.value)} />
        </label>
      </div>
      <label className={styles.check}>
        <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
        Supplier is active
      </label>
      <LoadingButton type="submit" className="secondary-button" busy={busy} busyLabel="Saving..." success={Boolean(message)} successLabel="Saved">
        Save supplier
      </LoadingButton>
      {message && <p className={styles.success} role="status">{message}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </form>
  );
}

function DemoTools({ onError }: { onError: (message: string) => void }) {
  const router = useRouter();
  const [simulateDate, setSimulateDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setSimulateDate(new Intl.DateTimeFormat("en-CA", {
      timeZone: "Australia/Sydney",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(tomorrow));
  }, []);

  async function simulateDay() {
    if (busy || !simulateDate) return;
    setBusy(true);
    setMessage("");
    onError("");
    try {
      const response = await fetch("/api/brief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh: true, date: simulateDate }),
      });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "The simulated brief could not be prepared.");
      setMessage("Brief ready.");
      window.dispatchEvent(new Event("brewlytics:navigation-start"));
      window.setTimeout(() => router.push(`/?date=${encodeURIComponent(simulateDate)}`), 240);
    } catch (simulationError) {
      onError(simulationError instanceof Error ? simulationError.message : "The simulated brief could not be prepared.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.card}>
      <h3>Demo tools</h3>
      <p>Simulate a different brief date, try the receiving sensor, or enter a manual sale.</p>
      <div className={styles.fieldGrid}>
        <label>Brief date
          <input type="date" required value={simulateDate} onChange={(event) => setSimulateDate(event.target.value)} />
        </label>
        <div className={styles.actions}>
          <LoadingButton type="button" className="primary-button" busy={busy} busyLabel="Preparing..." success={Boolean(message)} successLabel="Ready"
            disabled={!simulateDate} onClick={() => void simulateDay()}>
            Simulate a day
          </LoadingButton>
        </div>
      </div>
      {message && <p className={styles.success} role="status">{message}</p>}
      <div className={styles.linkList}>
        <Link className="secondary-button" href="/inventory/sales">Manual sale form</Link>
        <Link className="secondary-button" href="/inventory/deliveries#simulated-sensor">Arrival simulator and sensor</Link>
        <Link className="secondary-button" href="/inventory/deliveries#test-email-processing">Process due test emails</Link>
      </div>
      <p className={styles.notice}>
        The sales simulator is unavailable because historical sales have no hour-of-day data. Brewly will not invent an hourly pattern.
      </p>
    </div>
  );
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  async function loadSettings() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/agent/settings", { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error(responseError(payload) ?? "Café settings could not be loaded.");
      const parsed = responseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("The café settings response was invalid.");
      setSettings(parsed.data);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Café settings could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, []);

  return (
    <div className={styles.panel} aria-busy={loading}>
      <nav className={styles.sectionNav} aria-label="Settings sections">
        <a href="#autonomy">Autonomy</a>
        <a href="#suppliers">Suppliers</a>
        <a href="#cafe-profile">Café profile</a>
        <a href="#demo-tools">Demo tools</a>
      </nav>
      {loading && !settings && (
        <div className="loading-cards" role="status" aria-live="polite">
          <span className="sr-only">Loading café settings...</span>
          {Array.from({ length: 3 }, (_, index) => <Skeleton className="skeleton-row" key={index} />)}
        </div>
      )}
      {settings && (
        <>
          <section id="autonomy" className={styles.section} aria-labelledby="autonomy-title">
            <h2 id="autonomy-title">Autonomy</h2>
            <p className={styles.sectionDescription}>Brewly can only place routine simulated orders within these limits. Other actions stay in the approval inbox.</p>
            <PolicyForm key={JSON.stringify(settings.policy)} policy={settings.policy}
              paused={settings.profile.automationPaused} onSaved={loadSettings} />
            <div className={styles.card}>
              <h3>Reorder rules</h3>
              <p>Set one preferred supplier, normal pack quantity, per-order cap and on/off state per ingredient.</p>
              <div className={styles.ruleList}>
                {settings.ingredients.map((ingredient) => (
                  <ReorderRuleForm key={`${ingredient.id}:${JSON.stringify(ingredient.rule)}`}
                    ingredient={ingredient} onSaved={loadSettings} />
                ))}
              </div>
            </div>
            <div className={`${styles.card} ${styles.legacy}`}>
              <h3>Legacy approval rules — inactive</h3>
              <p>
                Older <code>standing_rules</code> and <code>rules</code> decision limits are inactive and cannot authorize orders.
                No legacy table or row has been deleted. Translate useful limits into the policy above after reviewing them.
              </p>
              {settings.legacyRules.map((rule, index) => (
                <p key={`${rule.name}:${index}`}>
                  <strong>{rule.name}</strong> · {rule.supplier ?? "No supplier"} · cap {rule.maximumTotal ? `$${rule.maximumTotal}` : "not set"}
                  {rule.enabled ? " · formerly enabled" : " · paused"}
                </p>
              ))}
              {!settings.legacyRules.length && <p>No non-demo legacy rules are available.</p>}
            </div>
          </section>
          <section id="suppliers" className={styles.section} aria-labelledby="suppliers-title">
            <h2 id="suppliers-title">Suppliers</h2>
            <p className={styles.sectionDescription}>Live contact details and lead times are used by the policy engine. Demo suppliers are hidden here.</p>
            <div className={styles.supplierList}>
              {settings.suppliers.map((supplier) => (
                <SupplierForm key={`${supplier.name}:${supplier.contactEmail}:${supplier.leadTimeDays}:${supplier.orderCutoff}:${supplier.deliveryWindowStart}:${supplier.deliveryWindowEnd}:${supplier.active}`}
                  supplier={supplier} onSaved={loadSettings} />
              ))}
              {!settings.suppliers.length && <p className={styles.notice}>No supplier records are available.</p>}
            </div>
          </section>
          <section id="cafe-profile" className={styles.section} aria-labelledby="profile-title">
            <h2 id="profile-title">Café profile</h2>
            <ProfileForm key={JSON.stringify(settings.profile)} profile={settings.profile} onSaved={loadSettings} />
          </section>
          <section id="demo-tools" className={styles.section} aria-labelledby="demo-tools-title">
            <h2 id="demo-tools-title">Demo tools</h2>
            <DemoTools onError={setError} />
          </section>
        </>
      )}
      {error && <p className={styles.error} role="alert">{error}</p>}
    </div>
  );
}
