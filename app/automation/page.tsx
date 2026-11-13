import { redirect } from "next/navigation";
import { connection } from "next/server";
import { hasAgentSession } from "@/lib/agent/auth";
import { inventoryClient } from "@/lib/inventory/server";
import { SiteNav } from "../site-nav";
import { RuleForm, ReviewForm, RetryMail } from "./forms";
import styles from "../inventory/deliveries/page.module.css";

export default async function AutomationPage() {
  await connection();
  if (!(await hasAgentSession())) redirect("/");
  const db = inventoryClient();
  const [prices, ingredients, inventory, rules, policy, orders, scans, mail, pending] = await Promise.all([
    db.from("supplier_prices").select("ingredient_id,supplier,price,minimum_order").order("ingredient_id"),
    db.from("ingredients").select("ingredient_id,ingredient_name,unit"),
    db.from("inventory").select("ingredient_id,minimum_stock"),
    db.from("cafe_reorder_rules").select("*"),
    db.from("cafe_spend_policy").select("daily_limit").eq("id",1).single(),
    db.from("cafe_sim_orders").select("*").neq("status","pending").order("created_at",{ascending:false}).limit(20),
    db.from("cafe_sensor_events").select("*").order("created_at",{ascending:false}).limit(20),
    db.from("cafe_test_mail").select("*").order("retry_at",{ascending:false}).limit(30),
    db.from("cafe_sim_orders").select("*").eq("status","pending").order("created_at"),
  ]);
  if ([prices, ingredients, inventory, rules, policy, orders, scans, mail, pending].some(result => result.error))
    return <main className="page-shell"><SiteNav current="automation"/><h1>Automation</h1><p role="alert">Could not load automation. Check the database connection and café autonomy SQL setup.</p></main>;
  const quotes = (prices.data ?? []).flatMap(p => {
    const item = ingredients.data?.find(i => i.ingredient_id === p.ingredient_id);
    const stock = inventory.data?.find(i => i.ingredient_id === p.ingredient_id);
    if (!item || !stock || !p.supplier) return [];
    const rule = rules.data?.find(r => r.ingredient_id === p.ingredient_id && r.supplier === p.supplier);
    return [{key: JSON.stringify([p.ingredient_id,p.supplier]),name: item.ingredient_name+" ("+item.unit+") · "+p.supplier,
      price: String(p.price), minimum: String(p.minimum_order), threshold: String(stock.minimum_stock ?? ""),
      packs: Number(rule?.packs ?? Math.max(1, Math.ceil(Number(p.minimum_order)))),limit:Number(rule?.order_limit ?? 50),enabled:rule?.enabled ?? false}];
  });
  const history = [...(pending.data ?? []), ...(orders.data ?? [])];
  return <main className="page-shell"><SiteNav current="automation"/><h1>Automation</h1>
    <section className={styles.section}><h2>Supplier orders</h2><p>Submitted test orders appear in <a href="/inventory/deliveries">Receive deliveries</a>.</p>
      {!history.length && <p>No order decisions recorded.</p>}
      {history.map(o => <article className={styles.card} key={o.id}><strong>{o.ingredient} · {o.packs} pack(s) · {o.total == null ? "Price unavailable" : "$"+Number(o.total).toFixed(2)}</strong>
        <p>{o.supplier} · {o.status} · {o.reason}</p>{o.delivery_id && <p>Simulated supplier confirmation SIM-{o.id} · delivery #{o.delivery_id}</p>}
        {o.status === "pending" && <ReviewForm id={o.id}/>}</article>)}
    </section>
    <section id="mailbox" className={styles.section}><h2>Supplier test mailbox</h2>
      {!mail.data?.length && <p>No delivery discrepancy emails.</p>}
      {mail.data?.map(job => <details className={styles.card} key={job.event_id}><summary>{job.payload?.subject ?? "Delivery discrepancy"} · {String(job.status).replaceAll("_"," ")}</summary>
        {job.payload && <><p>To {job.payload.to}</p><p style={{whiteSpace:"pre-wrap"}}>{job.payload.text}</p></>}
        {job.last_error && <p>{job.last_error}</p>}</details>)}<RetryMail/>
    </section>
    <section className={styles.section}><h2>Recent sensor readings</h2>{!scans.data?.length && <p>No scans recorded.</p>}
      {scans.data?.map(s => <p key={s.id}>Delivery #{s.delivery_id} · expected {s.expected_before} {s.unit} · measured {s.measured} {s.unit} · {s.outcome}</p>)}
    </section>
    <section className={styles.card}><h2>Reorder rules</h2><p>Choose one supplier per ingredient. The agent checks remaining stock and incoming deliveries after a sale, usage or waste.</p>
      <RuleForm quotes={quotes} daily={Number(policy.data?.daily_limit ?? 100)}/></section>
  </main>;
}
