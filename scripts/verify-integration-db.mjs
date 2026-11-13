// Isolated PostgreSQL-compatible test database. Never connects to Supabase.
// Requires the optional @electric-sql/pglite package; see INTEGRATION_SETUP.md.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

export const db = new PGlite();
const sql = async name => readFile(new URL(`../supabase/${name}.sql`, import.meta.url), 'utf8');
await db.exec(`
  create role anon; create role authenticated; create role service_role bypassrls;
  create table ingredients(ingredient_id integer primary key, ingredient_name text, unit text);
  create table inventory(ingredient_id bigint primary key references ingredients,quantity_in_stock numeric,last_updated timestamptz);
  create table recipes(product_name text,ingredient_id integer references ingredients,quantity_required numeric);
  create table "Historical Sales Data"("date" text,product_name text,quantity_sold integer,is_public_holiday integer);
  create table supplier_prices(supplier text,ingredient_id integer,price numeric,delivery_time integer,minimum_order numeric);
  insert into ingredients values(1,'Milk','ml'),(2,'Coffee Beans','g');
  insert into inventory values(1,20000,now()),(2,3000,now());
  insert into recipes values('Flat White',1,160),('Flat White',2,18);
  insert into "Historical Sales Data" values('2026-11-03','Flat White',100,0);
  insert into supplier_prices values('Test Supplier',1,2,1,5),('Test Supplier',2,30,1,1);
  grant select on ingredients,recipes,supplier_prices to service_role;
  grant select,update on inventory to service_role;
`);
for (const name of ['inventory-feature','automated-ordering-drafts','inventory-sales','inventory-deliveries']) await db.exec(await sql(name));
await db.exec(`insert into incoming_deliveries(ingredient_id,quantity,ordered_quantity,stock_unit,expected_date)
  values(1,5000,5000,'ml','2026-11-10')`);
const receive = async (amount, remaining, request = randomUUID(), note = 'Test arrival') =>
  (await db.query('select receive_inventory_delivery($1,1,$2,$3,$4) as result', [request,amount,remaining,note])).rows[0].result;
const stock = async () => (await db.query('select quantity_in_stock::text as amount from inventory order by ingredient_id')).rows.map(x=>x.amount);
const timestamp = async () => (await db.query('select last_updated::text as value from inventory where ingredient_id=1')).rows[0].value;
const snapshot = async () => (await db.query(`select
  (select jsonb_agg(i order by ingredient_id) from inventory i) as stock,
  (select jsonb_agg(r order by id) from delivery_receipts r) as receipts,
  (select jsonb_agg(m order by id) from inventory_movements m) as movements,
  (select jsonb_agg(s order by id) from inventory_sales s) as sales`)).rows[0];
let checks = 0;
const pass = message => { checks++; console.log(`PASS ${message}`); };

const originalRequest = randomUUID();
await receive(3000,5000,originalRequest);
// Reproduce the original branch's stored representation after a partial receipt.
await db.exec('update incoming_deliveries set quantity=2000 where delivery_id=1');
for (const name of ['agent-existing-schema-setup','agent-write-tools','agent-first-app','agent-legacy-receipt-write']) await db.exec(await sql(name));
const activity = async () => (await db.query("insert into agent_activity(tool,input_summary,outcome,reason) values('test','{}','started','Test') returning id")).rows[0].id;
const agentReceive = async (amount, id, expected, note = 'Agent test arrival') =>
  (await db.query('select record_agent_delivery_receipt($1,1,$2,$3,$4) as result', [id,amount,expected,note])).rows[0].result;
await agentReceive(1000,await activity(),await timestamp());
const beforeMigration = await snapshot();
const migration = await sql('inventory-agent-integration');
await db.exec(migration); await db.exec(migration);
assert.deepEqual(await snapshot(),beforeMigration);
assert.deepEqual((await db.query('select quantity::text,ordered_quantity::text,outstanding_quantity from inventory_delivery_balances')).rows[0],
  {quantity:'5000',ordered_quantity:'5000',outstanding_quantity:'1000'});
pass('migrating mixed legacy/page and agent receipts preserves stock and history; rerun is safe');

const fingerprint = async () => (await db.query('select inventory_brief_fingerprint() as value')).rows[0].value;
let oldFingerprint = await fingerprint();
const manualRequest = randomUUID();
await db.exec('set role service_role');
assert.equal((await receive(400,1000,manualRequest)).remaining,'600');
await db.exec('reset role');
assert.notEqual(await fingerprint(),oldFingerprint);
const afterManual = await snapshot();
assert.equal((await receive(400,1000,manualRequest)).replayed,true);
assert.equal((await receive(3000,5000,originalRequest)).replayed,true);
await assert.rejects(receive(300,1000,manualRequest),/RECEIPT_REQUEST_CONFLICT/);
await assert.rejects(receive(400,1000),/DELIVERY_CHANGED/);
await assert.rejects(receive(601,600),/EXCEEDS_OUTSTANDING/);
assert.deepEqual(await snapshot(),afterManual);
pass('manual receipt changes brief fingerprint; old/new retries replay and stale/excess requests do not write');

const agentId = await activity(), expected = await timestamp();
await db.exec('set role service_role');
assert.equal(String(await agentReceive(600,agentId,expected)),'25000');
assert.equal(String(await agentReceive(600,agentId,expected)),'25000');
await assert.rejects(agentReceive(500,agentId,expected),/RECEIPT_REQUEST_CONFLICT/);
await db.exec('reset role');
assert.equal((await db.query('select outstanding_quantity from inventory_delivery_balances')).rows[0].outstanding_quantity,'0');
assert.equal((await db.query('select quantity::text from incoming_deliveries')).rows[0].quantity,'5000');
assert.deepEqual(await stock(),['25000','3000']);
pass('page and agent receipts alternate correctly, close a delivery once, and retain original ordered quantity');

const saleId = randomUUID();
const sale = async (id=saleId,quantity=2) => (await db.query("select record_inventory_sale($1,'Flat White',$2) as result",[id,quantity])).rows[0].result;
oldFingerprint = await fingerprint();
await db.exec('set role service_role');
await sale();
assert.equal((await sale()).replayed,true);
await assert.rejects(sale(saleId,3),/SALE_REQUEST_CONFLICT/);
await assert.rejects(sale(randomUUID(),1000),/INSUFFICIENT_STOCK/);
await db.exec('reset role');
assert.deepEqual(await stock(),['24680','2964']);
assert.notEqual(await fingerprint(),oldFingerprint);
assert.equal((await db.query('select count(*)::int as n from sales_history')).rows[0].n,1);
pass('sales atomically deduct saved recipes once, invalidate brief cache, and do not pollute historical forecasts');

// Exact Sydney local day boundaries, plus an old saved recipe after recipe edits.
await db.query("update inventory_sales set created_at='2026-11-09T13:00:00Z' where id=$1",[saleId]);
await db.exec("update delivery_receipts set created_at='2026-11-10T12:59:59Z'");
await db.exec('update recipes set quantity_required=200 where ingredient_id=1');
const operations = async date => (await db.query('select inventory_recorded_operations($1) as value',[date])).rows[0].value;
await db.exec('set role service_role');
const today = await operations('2026-11-10');
assert.equal(today.drinksRecorded,2); assert.equal(today.transactionCount,1);
assert.deepEqual(today.ingredientsUsed.find(x=>x.name==='Milk'),{name:'Milk',unit:'ml',amount:'320'});
assert.deepEqual(today.deliveriesReceived,[{name:'Milk',unit:'ml',amount:'5000'}]);
assert.equal((await operations('2026-11-09')).drinksRecorded,0);
assert.equal((await operations('2026-11-11')).deliveriesReceived.length,0);
assert.equal(typeof await fingerprint(),'string');
await db.exec('reset role');
await db.query("update inventory_sales set created_at='2026-11-10T13:00:00Z' where id=$1",[saleId]);
assert.equal((await operations('2026-11-10')).drinksRecorded,0);
assert.equal((await operations('2026-11-11')).drinksRecorded,2);
pass('recorded activity uses Sydney midnight and saved recipe snapshots, excluding next-day entries');

oldFingerprint=await fingerprint();
await activity();
await db.exec("insert into daily_briefs(brief_date,greeting,status_line,all_clear) values('2026-11-10','Test','Test','Test')");
assert.equal(await fingerprint(),oldFingerprint);
await db.query("select record_inventory_movement(1,'waste',100,$1,'test waste')",[await timestamp()]);
assert.notEqual(await fingerprint(),oldFingerprint);
pass('cache writes and tool activity do not invalidate themselves; actual wastage does');

const beforeFailure = await snapshot();
await db.exec("create function reject_test_receipt() returns trigger language plpgsql as $$begin raise exception 'TEST_FAILURE'; end$$; create trigger reject_test_receipt before insert on delivery_receipts for each row execute function reject_test_receipt()");
await assert.rejects(agentReceive(10,await activity(),await timestamp()),/TEST_FAILURE/);
assert.deepEqual(await snapshot(),beforeFailure);
await db.exec('drop trigger reject_test_receipt on delivery_receipts; drop function reject_test_receipt()');
pass('receipt-write failure rolls back inventory and movement changes together');

for(const role of ['anon','authenticated']) {
  await db.exec(`set role ${role}`);
  await assert.rejects(operations('2026-11-10'),/permission denied/);
  await assert.rejects(fingerprint(),/permission denied/);
  await assert.rejects(sale(),/permission denied/);
  await assert.rejects(receive(1,1),/permission denied/);
  await assert.rejects(db.query('select * from inventory_delivery_balances'),/permission denied/);
  await db.exec('reset role');
}
pass('only privileged server calls can access operational data and stock writers');

await assert.rejects(db.exec('begin; update inventory set quantity_in_stock=0; update incoming_deliveries set quantity=0; commit;'),/incoming_original_quantity/);
await db.exec('rollback');
assert.deepEqual(await snapshot(),beforeFailure);
pass('accidental legacy decrement writer fails atomically instead of corrupting stock');

await db.exec('alter table incoming_deliveries drop constraint incoming_original_quantity; alter table incoming_deliveries alter column ordered_quantity drop not null; update incoming_deliveries set ordered_quantity=null');
await assert.rejects(db.exec(migration),/Original order quantity is missing/);
await db.exec('rollback');
assert.deepEqual(await snapshot(),beforeFailure);
assert.equal((await db.query('select ordered_quantity from incoming_deliveries')).rows[0].ordered_quantity,null);
await db.exec('update incoming_deliveries set ordered_quantity=5000');
await db.exec(migration);
pass('migration refuses missing original quantities with existing receipts, without guessing or changing stock');

console.log(`${checks} database scenario groups passed. PGlite uses one connection; independent-session lock races are not covered.`);
if (process.argv.includes('--operations') || process.argv.includes('--autonomy')) {
  const { verifyCafeOperations } = await import('./verify-cafe-operations.mjs');
  await verifyCafeOperations(db);
}
if (process.argv.includes('--autonomy')) {
  const { verifyAutonomy } = await import('./verify-cafe-autonomy.mjs');
  await verifyAutonomy(db);
}
if (!process.argv.includes('--serve')) await db.close();
