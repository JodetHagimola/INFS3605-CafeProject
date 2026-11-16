"use client";

import { useActionState, useState } from "react";
import type { Delivery } from "@/lib/inventory-deliveries/server";
import { scanDelivery, saveRule, saveSupplierWindow, reviewOrder, retryMail } from "./actions";
import styles from "../inventory/deliveries/page.module.css";

export function SensorForm({deliveries, canWrite}: {deliveries: Delivery[]; canWrite: boolean}) {
  const [id, setId] = useState("");
  const [message, action, busy] = useActionState(scanDelivery, "");
  const item = deliveries.find(d => d.id === id) ?? deliveries[0];
  return <section id="simulated-sensor" className={styles.card}><h2>Simulated receiving sensor</h2>
    <p>Choose a test reading. The packing slip identifies whether another shipment is due.</p>
    {item && <form action={action} className={styles.form}><fieldset disabled={!canWrite || busy}>
      <label>Expected delivery<select name="delivery" value={item.id} onChange={e => setId(e.target.value)}>
        {deliveries.map(d => <option key={d.id} value={d.id}>#{d.id} · {d.name} · {d.outstanding} {d.unit} due</option>)}
      </select></label>
      <input name="balance" type="hidden" value={item.outstanding}/><input name="unit" type="hidden" value={item.unit}/>
      <label>Test reading<select name="scenario">
        <option value="full">Full delivery · 100%</option><option value="partial">Part delivery · 80%, more coming</option>
        <option value="final_short">Final delivery · 80%, no more coming</option><option value="extra">Extra goods · 120%</option>
      </select></label>
      <button className="primary-button">{busy ? "Recording scan…" : "Run simulated scan"}</button>
    </fieldset></form>}
    {!item && <p>No expected deliveries to scan.</p>}
    {message && <p role="status">{message}</p>}
    <div id="test-email-processing">
      <h3>Test email processing</h3>
      <p>Retry due messages in the configured test channel. Supplier contacts are blocked from the test recipient.</p>
      <RetryMail />
    </div>
  </section>;
}

export type Quote = { key: string; name: string; price: string; minimum: string; threshold: string; autoThreshold: boolean; packs: number; limit: number; enabled: boolean };
export function RuleForm({quotes, daily}: {quotes: Quote[]; daily: number}) {
  const [key, setKey] = useState(quotes[0]?.key ?? "");
  const quote = quotes.find(q => q.key === key) ?? quotes[0];
  const [message, action, busy] = useActionState(saveRule, "");
  if (!quote) return <p>Add a supplier price and an inventory record to configure a rule.</p>;
  return <form action={action} className={styles.form}><fieldset disabled={busy}>
    <label>Ingredient and supplier<select name="quote" value={quote.key} onChange={e => setKey(e.target.value)}>
      {quotes.map(q => <option key={q.key} value={q.key}>{q.name}</option>)}</select></label>
    <p>Price per pack: ${quote.price}. Supplier minimum: {quote.minimum} pack(s).</p>
      <p>{quote.autoThreshold
        ? `Brewly's automatic stock threshold: ${quote.threshold || "waiting for usable sales and lead-time data"}`
        : `Automatic thresholds are off. Current minimum: ${quote.threshold || "not set"}`}</p>
      <fieldset key={quote.key}>
      <label>Packs to order<input name="packs" type="number" min="1" max="10000" required defaultValue={quote.packs}/></label>
      <label>Auto-submit below (AUD)<input name="limit" type="number" min=".01" max="1000000" step=".01" required defaultValue={quote.limit}/></label>
      <label>Shared daily budget (AUD)<input name="daily" type="number" min=".01" max="1000000" step=".01" required defaultValue={daily}/></label>
      <label className={styles.check}><input name="enabled" type="checkbox" defaultChecked={quote.enabled}/>Enable this supplier rule</label>
    </fieldset><button className="primary-button">Save rule</button></fieldset>{message && <p role="status">{message}</p>}</form>;
}

type SupplierWindow = { name: string; delivery_window_start: string | null; delivery_window_end: string | null };
export function SupplierWindows({suppliers}: {suppliers: SupplierWindow[]}) {
  if (!suppliers.length) return <p>Add supplier records before setting delivery windows.</p>;
  return <div className={styles.grid}>
    {suppliers.map(supplier => <SupplierWindowRow key={supplier.name} supplier={supplier}/>)}
  </div>;
}

function SupplierWindowRow({supplier}: {supplier: SupplierWindow}) {
  const [message, action, busy] = useActionState(saveSupplierWindow, "");
  return <form action={action} className={`${styles.card} ${styles.form}`}>
    <input type="hidden" name="supplier" value={supplier.name}/>
    <strong>{supplier.name}</strong>
    <p className={styles.muted}>Arrival window in Australia/Sydney time. Leave both blank to disable simulated receiving for this supplier.</p>
    <fieldset disabled={busy}>
      <label>Window starts<input type="time" name="windowStart" defaultValue={supplier.delivery_window_start?.slice(0, 5) ?? ""}/></label>
      <label>Window ends<input type="time" name="windowEnd" defaultValue={supplier.delivery_window_end?.slice(0, 5) ?? ""}/></label>
      <button type="submit" className="primary-button">{busy ? "Saving…" : "Save delivery window"}</button>
    </fieldset>
    {message && <p role="status">{message}</p>}
  </form>;
}

export function ReviewForm({id}: {id: string}) {
  const [message, action, busy] = useActionState(reviewOrder, "");
  return <form action={action}><input type="hidden" name="order" value={id}/>
    <button className="primary-button" disabled={busy} name="decision" value="approve">Approve order</button>{" "}
    <button className="reject-button" disabled={busy} name="decision" value="reject">Decline</button><span role="status">{message}</span>
  </form>;
}

export function RetryMail() {
  const [message, action, busy] = useActionState(retryMail, "");
  return <form action={action}><button className="primary-button" disabled={busy}>Process due test emails</button><span role="status">{message}</span></form>;
}
