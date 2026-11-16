"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { countedAmount, type InventoryItem, type StockStatus } from "@/lib/inventory/model";
import { displayAmount } from "@/lib/inventory-sales/model";
import { recordInventoryCount, type CountState } from "./actions";
import { LoadingButton } from "../ui/feedback";
import styles from "./inventory.module.css";

const initial: CountState = { status: "idle", message: "" };
const numberFormat = new Intl.NumberFormat("en-AU", { maximumFractionDigits: 6 });
const dateFormat = new Intl.DateTimeFormat("en-AU", { dateStyle: "medium", timeStyle: "short", timeZone: "Australia/Sydney" });

function UpdateForm({ item, canWrite }: { item: InventoryItem; canWrite: boolean }) {
  const [state, action, pending] = useActionState(recordInventoryCount, initial);
  const [amount, setAmount] = useState(item.quantity === null ? "" : displayAmount(item.quantity));
  const [justSaved, setJustSaved] = useState(false);
  const unavailable = !canWrite || item.quantity === null || item.status === "Check data" || !item.updated;
  const validCount = countedAmount(amount) !== null;
  useEffect(() => {
    if (state.status !== "success") return;
    setJustSaved(true);
    const timeout = window.setTimeout(() => setJustSaved(false), 900);
    return () => window.clearTimeout(timeout);
  }, [state]);
  return <form action={action} className={styles.form} aria-busy={pending}>
    <input type="hidden" name="id" value={item.id} />
    <input type="hidden" name="updated" value={item.updated ?? ""} />
    <fieldset disabled={pending || unavailable}>
      <legend>Correct the recorded count for {item.name}</legend>
      <label>Counted stock ({item.unit})
        <input name="amount" type="number" min="0" max="1000000000" step="0.000001"
          required value={amount} onChange={event => setAmount(event.target.value)} />
      </label>
      <label>Reason / reference
        <input name="note" required maxLength={200} placeholder="e.g. Physical count at close" />
      </label>
      <p>Enter the amount physically counted. Any difference is recorded as an adjustment with this reason.</p>
      <LoadingButton
        type="submit"
        busy={pending}
        busyLabel="Saving..."
        success={justSaved && !pending}
        successLabel="Saved"
        disabled={!validCount}
      >
        Save corrected count
      </LoadingButton>
    </fieldset>
    {unavailable && <p>{!canWrite ? "Stock changes are disabled by server policy." : "A valid inventory record and timestamp are required before correcting stock."}</p>}
    {state.message && <p role="status" className={state.status === "error" ? styles.error : styles.success}>{state.message}</p>}
  </form>;
}

export default function InventoryPanel({ items, canWrite }: { items: InventoryItem[]; canWrite: boolean }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    if (selected || refreshing) return;
    function refresh() {
      if (document.visibilityState === "visible") startRefresh(() => router.refresh());
    }
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [selected, refreshing, router]);
  const low = items.filter(item => item.status === "Low stock").length;
  const empty = items.filter(item => item.status === "Out of stock").length;
  const visible = items.filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()) &&
    (filter === "all" || (filter === "attention" ? ["Low stock", "Out of stock"].includes(item.status) : item.status === filter)));
  const active = items.find(item => item.id === selected);
  const statusClass = (status: StockStatus) => status === "In stock" ? styles.good :
    status === "Low stock" ? styles.low : status === "Out of stock" || status === "Check data" ? styles.bad : styles.neutral;
  return <div className={styles.panel}>
    <div className={styles.metrics}>
      <div><strong>{items.length}</strong><span>Ingredients</span></div>
      <div><strong>{low}</strong><span>Low stock</span></div>
      <div><strong>{empty}</strong><span>Out of stock</span></div>
    </div>
    <div className={styles.filters}>
      <label>Search ingredients<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search by name" /></label>
      <label>Stock status<select value={filter} onChange={event => setFilter(event.target.value)}>
        <option value="all">All ingredients</option><option value="attention">Needs replenishment</option>
        {["Low stock", "Out of stock", "In stock", "Threshold not set", "No stock record", "Check data"].map(status => <option key={status}>{status}</option>)}
      </select></label>
      <LoadingButton
        type="button"
        className={styles.refresh}
        busy={refreshing}
        busyLabel="Refreshing..."
        onClick={() => startRefresh(() => router.refresh())}
      >
        Refresh stock
      </LoadingButton>
    </div>
    <p aria-live="polite">Showing {visible.length} of {items.length} ingredients</p>
    {visible.length === 0 ? <div className="empty-state">{items.length === 0 ? "No ingredients have been added yet." : "No ingredients match these filters."}</div> :
      <div className="table-wrap"><table>
        <caption className={styles.caption}>These are ledger-based quantities. Physical-count dates indicate when stock was last verified. Times use Sydney time.</caption>
        <thead><tr><th scope="col">Ingredient</th><th scope="col">Stock</th><th scope="col">Minimum</th><th scope="col">Status</th><th scope="col">Last counted</th><th scope="col">Action</th></tr></thead>
        <tbody>{visible.map(item => <tr key={item.id}>
          <th scope="row">{item.name}</th>
          <td>{item.quantity === null ? "—" : `${numberFormat.format(item.quantity)} ${item.unit}`}</td>
          <td>{item.minimum === null ? "Not set" : `${numberFormat.format(item.minimum)} ${item.unit}`}
            {item.minimum !== null && <small className={styles.countNote}>{item.autoThreshold ? "Automatic" : "Manual"}</small>}</td>
          <td><span className={`${styles.badge} ${statusClass(item.status)}`}>{item.status}</span></td>
          <td><span className={`${styles.badge} ${item.countDue ? styles.low : styles.good}`}>
            {item.countDue ? "Count due" : "Count current"}
          </span>
            <small className={styles.countNote}>{item.lastCounted && Number.isFinite(Date.parse(item.lastCounted))
              ? <time dateTime={item.lastCounted}>{dateFormat.format(new Date(item.lastCounted))}</time>
              : "No physical count"}</small>
          </td>
          <td><button className={styles.secondary} onClick={() => setSelected(item.id)} aria-label={`Correct ${item.name} count`}>Correct a number</button></td>
        </tr>)}</tbody>
      </table></div>}
    {active && <section className={styles.editor} aria-label={`Update ${active.name}`}>
      <div className={styles.editorHeading}><h2>{active.name}</h2><button className={styles.secondary} onClick={() => setSelected(null)}>Close</button></div>
      <p>Recorded stock: {active.quantity === null ? "Unknown" : `${numberFormat.format(active.quantity)} ${active.unit}`}</p>
      <UpdateForm key={`${active.id}:${active.updated ?? ""}:${active.lastCounted ?? ""}`} item={active} canWrite={canWrite} />
    </section>}
    <p className="sort-note">Brewly keeps this up to date from recorded sales, receipts and waste. Missing stock is never treated as zero or sufficient.</p>
  </div>;
}
