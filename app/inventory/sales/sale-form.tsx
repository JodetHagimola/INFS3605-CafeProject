"use client";

import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { displayAmount, parseSaleIntent, type SaleIntent, type SaleProduct, type SaleResult } from "@/lib/inventory-sales/model";
import { recordSale } from "./actions";
import styles from "./sales.module.css";

const storageKey = "brewlytics.inventory-sale.pending.v1";

export default function SaleForm({ products, canWrite }: { products: SaleProduct[]; canWrite: boolean }) {
  const router = useRouter();
  const inFlight = useRef(false);
  const [product, setProduct] = useState(products[0]?.name ?? "");
  const [quantity, setQuantity] = useState("1");
  const [intent, setIntent] = useState<SaleIntent | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<SaleResult>({ status: "idle", message: "" });
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey);
      if (saved) {
        const previous = parseSaleIntent(JSON.parse(saved));
        if (!previous) throw new Error("Invalid pending sale");
        setIntent(previous);
        setProduct(previous.product);
        setQuantity(String(previous.quantity));
        setResult({ status: "uncertain", message: "A previous sale needs confirmation. Retry the same sale to check whether it was saved without deducting stock again." });
      }
      setReady(true);
    } catch {
      setResult({ status: "error", message: "The browser could not restore the sale reference. Use a browser tab with session storage enabled and check sales history before entering another sale." });
    }
  }, []);

  const recipe = products.find(p => p.name === product);
  const count = Number(quantity);
  const validCount = /^\d+$/.test(quantity) && Number.isInteger(count) && count >= 1 && count <= 1000;
  const locked = pending || intent !== null;
  const confirmed = result.status === "success";

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || pending || !ready || !canWrite || confirmed) return;
    if (!intent && (!recipe || !validCount)) {
      setResult({ status: "error", message: "Choose a drink and enter a whole number from 1 to 1000." });
      return;
    }
    let submission: SaleIntent;
    try {
      submission = intent ?? { id: crypto.randomUUID(), product, quantity: count };
      // Persist before sending. A lost response or reload reuses this reference.
      sessionStorage.setItem(storageKey, JSON.stringify(submission));
    } catch {
      setResult({ status: "error", message: "The browser could not save the sale reference. Nothing was submitted. Enable session storage and try again." });
      return;
    }
    inFlight.current = true;
    setIntent(submission);
    startTransition(async () => {
      let response: SaleResult;
      try { response = await recordSale(submission); }
      catch { response = { status: "uncertain", message: "The response was interrupted. Retry this same sale rather than creating another entry." }; }
      inFlight.current = false;
      setResult(response);
      if (response.status === "error") {
        try { sessionStorage.removeItem(storageKey); setIntent(null); }
        catch { /* Keep the reference if local storage could not be cleared. */ }
      }
      if (response.status === "success") router.refresh();
    });
  }

  function nextSale() {
    try { sessionStorage.removeItem(storageKey); }
    catch { return; }
    setIntent(null);
    setQuantity("1");
    setResult({ status: "idle", message: "" });
  }

  return <div className={styles.card}>
    {!canWrite && <p className="notice">Sign in to record sales.</p>}
    <form onSubmit={save}>
      <div className={styles.fields}>
        <label htmlFor="sale-drink">Drink
          <select id="sale-drink" value={product} disabled={locked || !canWrite || !ready}
            onChange={e => setProduct(e.target.value)}>
            {!recipe && product && <option value={product}>{product}</option>}
            {products.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select>
        </label>
        <label htmlFor="sale-quantity">Number of drinks
          <input id="sale-quantity" type="number" min="1" max="1000" step="1" required value={quantity}
            disabled={locked || !canWrite || !ready} onChange={e => setQuantity(e.target.value)} />
        </label>
      </div>
      {recipe && validCount && <div className={styles.preview}>
        <h2>Ingredient usage</h2>
        <ul>{recipe.parts.map(part => <li key={part.ingredientId}>
          <span>{part.name}</span><strong>{displayAmount(part.perDrink * count)} {part.unit}</strong>
        </li>)}</ul>
        <p>The saved sale uses the current database recipe. Stock is checked when you confirm.</p>
      </div>}
      <p>Record a completed sale once. Do not also enter the same ingredient usage through the manual stock form.</p>
      {!confirmed && <button type="submit" className={styles.primary}
        disabled={pending || !ready || !canWrite || (!intent && (!recipe || !validCount))}>
        {pending ? "Saving sale…" : intent ? "Retry same sale" : "Confirm sale"}
      </button>}
    </form>
    {result.message && <p role="status" className={result.status === "success" ? styles.success : styles.error}>{result.message}</p>}
    {result.receipt && <section aria-label="Saved sale receipt" className={styles.receipt}>
      <h2>{result.receipt.quantity} × {result.receipt.product_name}</h2>
      <div className={styles.tableWrap}><table>
        <caption>Stock immediately before and after this sale</caption>
        <thead><tr><th>Ingredient</th><th>Before</th><th>Used</th><th>After</th></tr></thead>
        <tbody>{result.receipt.changes.map(c => <tr key={c.ingredient_id}>
          <th>{c.name}</th><td>{displayAmount(c.before)} {c.unit}</td>
          <td>{displayAmount(c.amount)} {c.unit}</td><td>{displayAmount(c.after)} {c.unit}</td>
        </tr>)}</tbody>
      </table></div>
      <p>Later stock changes are shown on the Inventory page.</p>
    </section>}
    {intent && <p className={styles.reference}>Sale reference: <code>{intent.id}</code></p>}
    {confirmed && <div className={styles.buttons}>
      <button type="button" className={styles.primary} onClick={nextSale}>Record another sale</button>
      <a className={styles.secondary} href="/inventory">View updated inventory</a>
    </div>}
    {result.status === "uncertain" && <p>Keep this tab open and use <strong>Retry same sale</strong> after checking the connection. The same reference will not deduct stock twice.</p>}
  </div>;
}
