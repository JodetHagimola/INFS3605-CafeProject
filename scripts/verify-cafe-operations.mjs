import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { supplierDraft } from '../lib/inventory-deliveries/shortage-email.ts';

export async function verifyCafeOperations(db) {
  const sql = await readFile(new URL('../supabase/cafe-operations-agent.sql',import.meta.url),'utf8');
  await db.exec(sql);
  const first = async (query, args=[]) => (await db.query(query,args)).rows[0];
  const capacity = async (name='Flat White') => (await first('select drink_capacity($1) as value',[name])).value;
  const milk = async () => (await first('select quantity_in_stock::text as n from inventory where ingredient_id=1')).n;
  await db.exec("update inventory set quantity_in_stock=case ingredient_id when 1 then 20000 else 3000 end; update recipes set quantity_required=160 where ingredient_id=1");
  await db.exec('set role service_role');
  assert.equal((await capacity()).wholeDrinks,'125');
  await db.query("select record_inventory_sale($1,'Flat White',2)",[randomUUID()]);
  const result = await capacity();
  assert.equal(result.wholeDrinks,'123');
  assert.equal(result.limitingIngredients[0].name,'Milk');
  assert.equal((await capacity('Unknown')).status,'unknown_product');
  await db.exec('reset role');
  await db.exec("begin; update inventory set quantity_in_stock=null where ingredient_id=2");
  assert.equal((await capacity()).status,'incomplete_recipe_or_stock');
  await db.exec('rollback');
  await db.exec("begin; insert into recipes values('Flat White',1,160)");
  assert.equal((await capacity()).status,'incomplete_recipe_or_stock');
  await db.exec('rollback');
  console.log('PASS sales change capacity and limiting ingredient; unknown, duplicate, or missing inputs stay unknown');

  const line = {ingredientId:'1',unit:'ml',recommendedOrderQuantity:5000,recommendedSupplier:{supplier:'Demo Dairy'}};
  const order = await first("insert into draft_orders(status,forecast_date,forecast,lines,flags,data_used,approved_at) values ('approved',current_date,'{}',$1,'[]','{}',now()) returning id",[JSON.stringify([line])]);
  await db.query("select register_order_delivery($1,current_date,'PO-AGENT')",[order.id]);
  const {delivery_id: id} = await first("select delivery_id from incoming_deliveries where supplier_name='Demo Dairy'");
  const receive = async (key,qty,remaining,final) => (await first("select receive_classified_delivery($1,$2,$3,$4,'checked',$5) as data",[key,id,qty,remaining,final])).data;
  await db.exec('set role service_role');
  await receive(randomUUID(),1000,5000,false);
  assert.equal((await first('select count(*)::int as n from delivery_shortage_drafts')).n,0);
  assert.equal((await first('select outstanding_quantity from open_delivery_balances where delivery_id=$1',[id])).outstanding_quantity,'4000');
  const key=randomUUID();
  const final=await receive(key,3000,4000,true);
  assert.equal(final.closed_short,true);
  assert.equal((await receive(key,3000,4000,true)).replayed,true);
  await assert.rejects(receive(key,3000,4000,false),/RECEIPT_REQUEST_CONFLICT/);
  assert.equal(await milk(),'23680');
  assert.equal(await first('select * from open_incoming_deliveries where delivery_id=$1',[id]),undefined);
  assert.equal(await first('select * from open_delivery_balances where delivery_id=$1',[id]),undefined);
  const draft = await first('select * from delivery_shortage_drafts where receipt_id=$1',[key]);
  assert.equal(draft.facts.received,'4000');
  assert.equal(draft.facts.missing,'1000');
  assert.equal(draft.facts.reference,'PO-AGENT');
  assert.equal(draft.facts.supplier,'Demo Dairy');
  assert.equal(supplierDraft(draft).source,'Standard draft');
  assert.match(supplierDraft(draft).body,/short by 1000 ml/);
  await db.query("update delivery_shortage_drafts set approach='replacement_eta' where receipt_id=$1 and approach is null",[key]);
  const tailored=supplierDraft(await first('select * from delivery_shortage_drafts where receipt_id=$1',[key]));
  assert.equal(tailored.source,'Agent-assisted draft');
  assert.match(tailored.body,/when it could arrive/);
  assert.match(tailored.body,/received 4000 ml in total/);
  console.log('PASS partial, cumulative final shortage, replay, persisted email facts, both draft modes and forecast exclusion');

  await assert.rejects(receive(randomUUID(),100,1000,false),/DELIVERY_CLOSED_SHORT/);
  const activity=await first("insert into agent_activity(tool,input_summary,outcome,reason) values('test','{}','started','Test') returning id");
  await assert.rejects(db.query("select record_agent_delivery_receipt($1,$2,100,(select last_updated from inventory where ingredient_id=1),'extra')",[activity.id,id]),/DELIVERY_CLOSED_SHORT/);
  assert.equal(await milk(),'23680');
  assert.equal((await first('select count(*)::int as n from delivery_shortage_drafts')).n,1);
  const exact=await first("insert into incoming_deliveries(ingredient_id,quantity,ordered_quantity,stock_unit,expected_date) values(1,100,100,'ml',current_date) returning delivery_id");
  assert.equal((await first("select receive_classified_delivery($1,$2,100,100,'checked',true) as data",[randomUUID(),exact.delivery_id])).data.closed_short,false);
  assert.equal((await first('select count(*)::int as n from delivery_shortage_drafts')).n,1);
  await db.exec('reset role');
  await db.exec(sql);
  assert.equal((await first('select count(*)::int as n from delivery_shortage_drafts')).n,1);
  for(const role of ['anon','authenticated']) {
    await db.exec('set role '+role);
    await assert.rejects(capacity(),/permission denied/);
    await assert.rejects(db.query('select * from delivery_shortage_drafts'),/permission denied/);
    await assert.rejects(receive(randomUUID(),100,1000,false),/permission denied/);
    await db.exec('reset role');
  }
  console.log('PASS both receipt writers roll back attempts to reopen a final shortage, full deliveries, migration rerun and permissions');
}
