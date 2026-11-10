-- Integration of inventory-check with main (2026-11-10).
-- Prerequisites: installed sales/delivery features and the current main agent setup.
-- Changes incoming quantity to ORIGINAL ordered quantity; never changes stock.
-- Do not run the old branch's inventory-deliveries.sql after this migration.
begin;
do $$
declare t text;
begin
  foreach t in array array['inventory_sales','inventory_sale_ingredients','delivery_batches','incoming_deliveries',
    'delivery_receipts','inventory','inventory_movements','draft_orders','daily_briefs','agent_activity',
    'sales_history','standing_rules','public_holidays','approval_inbox'] loop
    if to_regclass('public.' || t) is null then raise exception 'Required relation missing: %', t; end if;
  end loop;
end $$;
lock table public.incoming_deliveries, public.delivery_receipts in share row exclusive mode;
do $$ begin
  if exists(select 1 from public.incoming_deliveries d where
      (d.ordered_quantity is null and exists(select 1 from public.delivery_receipts r where r.delivery_id=d.delivery_id))
      or coalesce(d.ordered_quantity,d.quantity) is null
      or coalesce(d.ordered_quantity,d.quantity) < 0
      or coalesce(d.ordered_quantity,d.quantity)::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Original order quantity is missing or invalid. Review delivery history before migrating.';
  end if;
end $$;
update public.incoming_deliveries set quantity=coalesce(ordered_quantity,quantity), ordered_quantity=coalesce(ordered_quantity,quantity)
  where ordered_quantity is null or quantity is distinct from ordered_quantity;
alter table public.incoming_deliveries alter column ordered_quantity set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.incoming_deliveries'::regclass and conname='incoming_original_quantity') then
    alter table public.incoming_deliveries add constraint incoming_original_quantity
      check(quantity=ordered_quantity and quantity>=0 and quantity::text not in ('NaN','Infinity','-Infinity'));
  end if;
end $$;
-- Protect against accidentally running the old decrementing receipt writer.
-- Its entire transaction will fail rather than creating a partial stock update.
alter table public.delivery_receipts add column if not exists agent_activity_id bigint references public.agent_activity(id);
alter table public.delivery_receipts add column if not exists received_quantity numeric generated always as (amount) stored;
alter table public.delivery_receipts add column if not exists received_at timestamptz generated always as (created_at) stored;
create unique index if not exists delivery_receipts_agent_activity_id_idx on public.delivery_receipts(agent_activity_id) where agent_activity_id is not null;
create index if not exists delivery_receipts_delivery_id_integration_idx on public.delivery_receipts(delivery_id);
create index if not exists inventory_sales_created_at_idx on public.inventory_sales(created_at);
create index if not exists delivery_receipts_created_at_idx on public.delivery_receipts(created_at);

create or replace view public.inventory_delivery_balances with (security_invoker=true) as
  select d.*, greatest(0,d.quantity-coalesce(r.received,0))::text as outstanding_quantity
  from public.incoming_deliveries d left join
    (select delivery_id,sum(amount) as received from public.delivery_receipts group by delivery_id) r using(delivery_id);
revoke all on public.inventory_delivery_balances from public,anon,authenticated;
grant select on public.inventory_delivery_balances to service_role;
create or replace function public.receive_inventory_delivery(
  p_request_id uuid, p_delivery_id bigint, p_amount numeric,
  p_expected_remaining numeric, p_note text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_delivery public.incoming_deliveries%rowtype;
  v_receipt public.delivery_receipts%rowtype;
  v_stock numeric;
  v_updated timestamptz;
  v_movement bigint;
  v_name text;
  v_unit text;
  v_replayed boolean := false;
  v_remaining numeric;
begin
  if p_request_id is null or p_delivery_id is null or p_amount is null or p_amount <= 0
    or p_amount > 1000000000 or p_amount::text in ('NaN','Infinity','-Infinity')
    or p_amount <> trunc(p_amount, 6) or p_expected_remaining is null
    or p_expected_remaining <= 0 or p_expected_remaining::text in ('NaN','Infinity','-Infinity')
    or p_note is null or length(btrim(p_note)) not between 1 and 120 then raise exception 'INVALID_RECEIPT'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_request_id::text, 0));
  select * into v_receipt from public.delivery_receipts where id = p_request_id;
  if found then
    if v_receipt.delivery_id <> p_delivery_id or v_receipt.amount <> p_amount
      or v_receipt.remaining_before <> p_expected_remaining or v_receipt.note <> btrim(p_note) then
      raise exception 'RECEIPT_REQUEST_CONFLICT';
    end if;
    v_replayed := true;
  else
    select * into v_delivery from public.incoming_deliveries where delivery_id = p_delivery_id for update;
    if not found then raise exception 'DELIVERY_NOT_FOUND'; end if;
    select greatest(0, v_delivery.quantity - coalesce(sum(amount), 0)) into v_remaining
      from public.delivery_receipts where delivery_id = p_delivery_id;
    if v_remaining is distinct from p_expected_remaining then raise exception 'DELIVERY_CHANGED'; end if;
    if p_amount > v_remaining then raise exception 'EXCEEDS_OUTSTANDING'; end if;
    select ingredient_name, unit into v_name, v_unit from public.ingredients where ingredient_id = v_delivery.ingredient_id;
    if not found or v_name is null or v_unit is null or btrim(v_unit) = '' then raise exception 'INVALID_INGREDIENT'; end if;
    if v_delivery.stock_unit is distinct from v_unit then raise exception 'ORDER_UNIT_MISMATCH'; end if;
    select quantity_in_stock, last_updated into v_stock, v_updated
      from public.inventory where ingredient_id = v_delivery.ingredient_id for update;
    if not found then raise exception 'NO_STOCK_RECORD'; end if;
    if v_stock is null or v_stock < 0 or v_stock::text in ('NaN','Infinity','-Infinity') then raise exception 'INVALID_STOCK'; end if;
    update public.inventory set quantity_in_stock = v_stock + p_amount,
      last_updated = greatest(clock_timestamp(), v_updated + interval '1 millisecond')
      where ingredient_id = v_delivery.ingredient_id;
    insert into public.inventory_movements(ingredient_id, kind, amount, quantity_before, quantity_after, note)
      values(v_delivery.ingredient_id, 'delivery', p_amount, v_stock, v_stock + p_amount,
        'Receipt ' || p_request_id::text || ': ' || btrim(p_note)) returning id into v_movement;
    insert into public.delivery_receipts(id, delivery_id, ingredient_id, ingredient_name, unit, amount,
      remaining_before, remaining_after, stock_before, stock_after, note, movement_id)
      values(p_request_id, p_delivery_id, v_delivery.ingredient_id, v_name, v_unit, p_amount,
        v_remaining, v_remaining - p_amount, v_stock, v_stock + p_amount, btrim(p_note), v_movement)
      returning * into v_receipt;
  end if;
  return jsonb_build_object('receipt_id', v_receipt.id, 'name', v_receipt.ingredient_name, 'unit', v_receipt.unit,
    'amount', v_receipt.amount::text, 'before', v_receipt.stock_before::text, 'after', v_receipt.stock_after::text,
    'remaining', v_receipt.remaining_after::text, 'replayed', v_replayed);
end;
$$;

create or replace function public.record_agent_delivery_receipt(
  p_activity_id bigint,
  p_delivery_id bigint,
  p_received_quantity numeric,
  p_expected_updated timestamptz,
  p_note text
) returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_ingredient_id bigint;
  v_ingredient_name text;
  v_unit text;
  v_ordered_quantity numeric;
  v_already_received numeric;
  v_remaining_before numeric;
  v_remaining_after numeric;
  v_stock_before numeric;
  v_stock_after numeric;
  v_previous_movement_id bigint;
  v_movement_id bigint;
  v_last_updated timestamptz;
  v_existing_stock numeric;
begin
  if p_received_quantity is null
    or p_received_quantity <= 0
    or p_received_quantity > 1000000000
    or p_received_quantity::text in ('NaN', 'Infinity', '-Infinity')
    or p_received_quantity <> trunc(p_received_quantity, 6)
    or p_note is null
    or length(trim(p_note)) not between 1 and 200 then
    raise exception 'INVALID_RECEIVED_QUANTITY_OR_NOTE';
  end if;

  perform 1 from public.agent_activity where id = p_activity_id for update;
  if not found then raise exception 'NO_ACTIVITY_RECORD'; end if;

  select stock_after into v_existing_stock
    from public.delivery_receipts
    where agent_activity_id = p_activity_id;
  if found then
    if not exists(select 1 from public.delivery_receipts where agent_activity_id = p_activity_id
      and delivery_id = p_delivery_id and amount = p_received_quantity and note = trim(p_note)) then
      raise exception 'RECEIPT_REQUEST_CONFLICT';
    end if;
    return v_existing_stock;
  end if;

  select
      delivery.ingredient_id,
      ingredient.ingredient_name,
      ingredient.unit,
      coalesce(delivery.ordered_quantity, delivery.quantity),
      inventory.quantity_in_stock,
      inventory.last_updated
    into
      v_ingredient_id,
      v_ingredient_name,
      v_unit,
      v_ordered_quantity,
      v_stock_before,
      v_last_updated
    from public.incoming_deliveries as delivery
    join public.ingredients as ingredient
      on ingredient.ingredient_id = delivery.ingredient_id
    join public.inventory as inventory
      on inventory.ingredient_id = delivery.ingredient_id
    where delivery.delivery_id = p_delivery_id
    for update of delivery, inventory;
  if not found then raise exception 'NO_INCOMING_DELIVERY_OR_STOCK'; end if;
  if v_ordered_quantity is null or v_ordered_quantity < 0 or v_ordered_quantity::text in ('NaN','Infinity','-Infinity') then
    raise exception 'INVALID_ORDERED_QUANTITY';
  end if;
  if exists(select 1 from public.incoming_deliveries where delivery_id = p_delivery_id and stock_unit is distinct from v_unit) then
    raise exception 'ORDER_UNIT_MISMATCH';
  end if;
  if v_last_updated is distinct from p_expected_updated then
    raise exception 'STALE_STOCK';
  end if;

  select coalesce(sum(amount), 0)
    into v_already_received
    from public.delivery_receipts
    where delivery_id = p_delivery_id;
  v_remaining_before := greatest(0, v_ordered_quantity - v_already_received);
  v_remaining_after := greatest(0, v_remaining_before - p_received_quantity);

  select coalesce(max(id), 0)
    into v_previous_movement_id
    from public.inventory_movements
    where ingredient_id = v_ingredient_id;

  v_stock_after := public.record_inventory_movement(
    v_ingredient_id, 'delivery', p_received_quantity, p_expected_updated, trim(p_note)
  );

  select id into v_movement_id
    from public.inventory_movements
    where ingredient_id = v_ingredient_id
      and id > v_previous_movement_id
    order by id desc
    limit 1;
  if v_movement_id is null then raise exception 'NO_INVENTORY_MOVEMENT_RECORD'; end if;

  insert into public.delivery_receipts (
    id,
    delivery_id,
    ingredient_id,
    ingredient_name,
    unit,
    amount,
    remaining_before,
    remaining_after,
    stock_before,
    stock_after,
    note,
    movement_id,
    created_at,
    agent_activity_id
  ) values (
    gen_random_uuid(),
    p_delivery_id,
    v_ingredient_id,
    v_ingredient_name,
    v_unit,
    p_received_quantity,
    v_remaining_before,
    v_remaining_after,
    v_stock_before,
    v_stock_after,
    trim(p_note),
    v_movement_id,
    clock_timestamp(),
    p_activity_id
  );

  return v_stock_after;
end;
$$;

revoke all on function public.record_agent_delivery_receipt(bigint,bigint,numeric,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.record_agent_delivery_receipt(bigint,bigint,numeric,timestamptz,text)
  to service_role;


-- Recorded entries are operational evidence, separate from historical forecasting data.
create or replace function public.inventory_recorded_operations(p_date date) returns jsonb
language sql stable security invoker set search_path='' as $$
with bounds as (
  select p_date::timestamp at time zone 'Australia/Sydney' as start_at,
    (p_date+1)::timestamp at time zone 'Australia/Sydney' as end_at
), sales as (
  select s.* from public.inventory_sales s,bounds b where s.created_at>=b.start_at and s.created_at<b.end_at
), products as (
  select product_name,sum(quantity) as quantity from sales group by product_name
), usage as (
  select i.ingredient_name,i.unit,sum(i.amount)::text as amount
  from public.inventory_sale_ingredients i join sales s on s.id=i.sale_id group by i.ingredient_name,i.unit
), receipts as (
  select r.ingredient_name,r.unit,sum(r.amount)::text as amount from public.delivery_receipts r,bounds b
  where r.created_at>=b.start_at and r.created_at<b.end_at group by r.ingredient_name,r.unit
)
select jsonb_build_object('date',p_date::text,'transactionCount',(select count(*) from sales),
  'drinksRecorded',(select coalesce(sum(quantity),0) from sales),
  'products',coalesce((select jsonb_agg(jsonb_build_object('name',product_name,'quantity',quantity) order by product_name) from products),'[]'::jsonb),
  'ingredientsUsed',coalesce((select jsonb_agg(jsonb_build_object('name',ingredient_name,'unit',unit,'amount',amount) order by ingredient_name,unit) from usage),'[]'::jsonb),
  'deliveriesReceived',coalesce((select jsonb_agg(jsonb_build_object('name',ingredient_name,'unit',unit,'amount',amount) order by ingredient_name,unit) from receipts),'[]'::jsonb))
$$;
revoke all on function public.inventory_recorded_operations(date) from public,anon,authenticated;
grant execute on function public.inventory_recorded_operations(date) to service_role;

-- Full source digest is appropriate for this small prototype. For larger datasets,
-- replace it with transactional per-source versions without weakening freshness checks.
create or replace function public.inventory_brief_fingerprint() returns text
language sql stable security invoker set search_path='' as $$
  select md5(concat_ws('|',
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by ingredient_id),'') from public.inventory t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by ingredient_id),'') from public.ingredients t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by product_name,ingredient_id),'') from public.recipes t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by delivery_id),'') from public.incoming_deliveries t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by id),'') from public.delivery_receipts t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by id),'') from public.inventory_sales t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by sale_id,ingredient_id),'') from public.inventory_sale_ingredients t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by sales_date,product_name),'') from public.sales_history t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by supplier,ingredient_id),'') from public.supplier_prices t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by id),'') from public.standing_rules t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by holiday_date,jurisdiction),'') from public.public_holidays t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by id),'') from public.draft_orders t),
    (select coalesce(string_agg(md5(row_to_json(t)::text),'' order by id),'') from public.approval_inbox t)))
$$;
revoke all on function public.inventory_brief_fingerprint() from public,anon,authenticated;
grant execute on function public.inventory_brief_fingerprint() to service_role;

revoke all on function public.receive_inventory_delivery(uuid,bigint,numeric,numeric,text) from public,anon,authenticated;
grant execute on function public.receive_inventory_delivery(uuid,bigint,numeric,numeric,text) to service_role;
commit;
