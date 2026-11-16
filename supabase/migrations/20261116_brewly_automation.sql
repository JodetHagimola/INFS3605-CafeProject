-- =====================================================================
-- Brewly automation migration (idempotent). Verify against the live schema first.
-- =====================================================================

-- 1) One-row café settings: owner, hours, rush windows, email mode, kill switch
create table if not exists cafe_settings (
  id int primary key default 1 check (id = 1),
  cafe_name text not null default 'My Cafe',
  owner_name text,
  owner_email text,
  owner_phone text,
  timezone text not null default 'Australia/Sydney',
  open_time time not null default '06:00',
  close_time time not null default '16:00',
  rush_windows jsonb not null default '[{"start":"07:00","end":"09:30"},{"start":"12:00","end":"13:30"}]',
  email_mode text not null default 'test' check (email_mode in ('test','live')),
  automation_paused boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into cafe_settings (id) values (1) on conflict (id) do nothing;

-- 2) Suppliers become real records (needed for automated emails)
create table if not exists suppliers (
  name text primary key,
  contact_email text,
  lead_time_days int not null default 2,
  order_cutoff time,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
alter table public.suppliers enable row level security;
revoke all on public.suppliers from public, anon, authenticated;
grant select on public.suppliers to service_role;
insert into suppliers (name, contact_email)
select s, null
from (select supplier as s from supplier_prices where supplier is not null
      union select supplier_name from incoming_deliveries where supplier_name is not null) x
where length(btrim(s)) > 0
on conflict (name) do nothing;

-- 3) supplier_prices: say what one "pack" is, and a numeric lead time
alter table supplier_prices add column if not exists pack_size numeric not null default 1;
alter table supplier_prices add column if not exists pack_label text;
alter table supplier_prices add column if not exists lead_time_days int;
update supplier_prices
set lead_time_days = coalesce(nullif(substring(delivery_time from '[0-9]+'), '')::int, 2)
where lead_time_days is null;
update supplier_prices sp
set pack_size = v.pack_size, pack_label = v.label
from (values ('Milk',12000,'12 x 1 L crate'), ('Oat Milk',12000,'12 x 1 L carton'),
             ('Coffee Beans',1000,'1 kg bag'), ('Chocolate Powder',1000,'1 kg tub'),
             ('Vanilla Syrup',700,'700 mL bottle'), ('Caramel Syrup',700,'700 mL bottle'),
             ('Chai Powder',1000,'1 kg tub'), ('Matcha Powder',500,'500 g tin'),
             ('Sugar',1000,'1 kg bag'), ('Takeaway Cups',50,'sleeve of 50'), ('Lids',50,'sleeve of 50')
     ) v(ing, pack_size, label)
join ingredients i on i.ingredient_name = v.ing
where sp.ingredient_id = i.ingredient_id and sp.pack_size = 1;

-- 4) Delivery lifecycle: lets stale / overdue deliveries be closed instead of lingering forever
alter table incoming_deliveries add column if not exists status text not null default 'expected';
alter table incoming_deliveries add column if not exists closed_at timestamptz;
alter table incoming_deliveries add column if not exists closed_reason text;
alter table incoming_deliveries add column if not exists chase_count int not null default 0;
alter table incoming_deliveries add column if not exists last_chased_at timestamptz;
alter table incoming_deliveries add column if not exists source text not null default 'order';
alter table incoming_deliveries drop constraint if exists incoming_deliveries_status_check;
alter table incoming_deliveries add constraint incoming_deliveries_status_check
  check (status in ('expected','partially_received','received','lapsed','cancelled'));

-- Derive the initial lifecycle state from existing receipt totals.
with received as (
  select delivery_id, sum(amount) as received_quantity
  from delivery_receipts
  group by delivery_id
)
update incoming_deliveries d
set status = case
      when d.quantity = 0 or coalesce(r.received_quantity, 0) >= d.quantity then 'received'
      when coalesce(r.received_quantity, 0) > 0 then 'partially_received'
      else 'expected'
    end,
    closed_at = case
      when d.quantity = 0 or coalesce(r.received_quantity, 0) >= d.quantity
        then coalesce(d.closed_at, now())
      else null
    end,
    closed_reason = case
      when d.quantity = 0 or coalesce(r.received_quantity, 0) >= d.quantity
        then coalesce(d.closed_reason, 'Fully received before lifecycle tracking')
      else null
    end
from (select delivery_id, received_quantity from received) r
where d.status = 'expected' and r.delivery_id = d.delivery_id;

update incoming_deliveries d
set status = 'received',
    closed_at = coalesce(d.closed_at, now()),
    closed_reason = coalesce(d.closed_reason, 'Zero-quantity delivery')
where d.status = 'expected' and d.quantity = 0;

-- retire the two stale test deliveries behind the "milk delivery is overdue" warning
update incoming_deliveries
set status = 'lapsed', closed_at = now(), closed_reason = 'Stale test delivery retired during data cleanup'
where delivery_id in (1, 113) and status in ('expected', 'partially_received');

-- Keep the existing view columns in order, appending the new lifecycle fields.
create or replace view public.agent_delivery_status with (security_invoker=true) as
select
  d.delivery_id,
  d.ingredient_id,
  d.quantity,
  d.expected_date,
  d.demo_key,
  d.batch_id,
  d.ordered_quantity,
  d.supplier_name,
  d.stock_unit,
  f.receipt_id is not null as closed_short,
  d.status,
  d.closed_at,
  d.closed_reason,
  d.chase_count,
  d.last_chased_at,
  d.source
from public.incoming_deliveries d
left join public.delivery_shortage_drafts f using (delivery_id);

create or replace view public.open_incoming_deliveries with (security_invoker=true) as
select *
from public.agent_delivery_status
where not closed_short and status in ('expected', 'partially_received');

create or replace view public.open_delivery_balances with (security_invoker=true) as
select b.*
from public.inventory_delivery_balances b
join public.incoming_deliveries d using (delivery_id)
where d.status in ('expected', 'partially_received')
  and not exists (
    select 1 from public.delivery_shortage_drafts f where f.delivery_id = b.delivery_id
  );

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
  v_remaining_after numeric;
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
    if v_delivery.status not in ('expected', 'partially_received') then
      raise exception 'DELIVERY_NOT_OPEN';
    end if;
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
    v_remaining_after := v_remaining - p_amount;
    insert into public.delivery_receipts(id, delivery_id, ingredient_id, ingredient_name, unit, amount,
      remaining_before, remaining_after, stock_before, stock_after, note, movement_id)
      values(p_request_id, p_delivery_id, v_delivery.ingredient_id, v_name, v_unit, p_amount,
        v_remaining, v_remaining_after, v_stock, v_stock + p_amount, btrim(p_note), v_movement)
      returning * into v_receipt;
    update public.incoming_deliveries
    set status = case when v_remaining_after = 0 then 'received' else 'partially_received' end,
        closed_at = case when v_remaining_after = 0 then clock_timestamp() else null end,
        closed_reason = case when v_remaining_after = 0 then 'Fully received' else null end
    where delivery_id = p_delivery_id;
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
  v_status text;
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
      inventory.last_updated,
      delivery.status
    into
      v_ingredient_id,
      v_ingredient_name,
      v_unit,
      v_ordered_quantity,
      v_stock_before,
      v_last_updated,
      v_status
    from public.incoming_deliveries as delivery
    join public.ingredients as ingredient
      on ingredient.ingredient_id = delivery.ingredient_id
    join public.inventory as inventory
      on inventory.ingredient_id = delivery.ingredient_id
    where delivery.delivery_id = p_delivery_id
    for update of delivery, inventory;
  if not found then raise exception 'NO_INCOMING_DELIVERY_OR_STOCK'; end if;
  if v_status not in ('expected', 'partially_received') then
    raise exception 'DELIVERY_NOT_OPEN';
  end if;
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
  if p_received_quantity > v_remaining_before then raise exception 'EXCEEDS_OUTSTANDING'; end if;
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

  update public.incoming_deliveries
  set status = case when v_remaining_after = 0 then 'received' else 'partially_received' end,
      closed_at = case when v_remaining_after = 0 then clock_timestamp() else null end,
      closed_reason = case when v_remaining_after = 0 then 'Fully received' else null end
  where delivery_id = p_delivery_id;

  return v_stock_after;
end;
$$;

-- 5) Inventory: automatic timestamps + physical-count tracking + no more "no inventory record"
alter table inventory add column if not exists last_counted_at timestamptz;
alter table inventory add column if not exists auto_threshold boolean not null default true;
alter table inventory add column if not exists auto_threshold_updated_at timestamptz;

alter table public.inventory_movements drop constraint if exists inventory_movements_kind_check;
alter table public.inventory_movements add constraint inventory_movements_kind_check
  check (kind in ('delivery', 'usage', 'waste', 'adjustment'));

create or replace function brewly_touch_inventory() returns trigger language plpgsql as $f$
begin
  update inventory
  set last_updated = greatest(coalesce(last_updated, new.created_at), new.created_at)
  where ingredient_id = new.ingredient_id;
  return new;
end $f$;
drop trigger if exists trg_touch_inventory on inventory_movements;
create trigger trg_touch_inventory after insert on inventory_movements
  for each row execute function brewly_touch_inventory();

create or replace function brewly_new_ingredient_inventory() returns trigger language plpgsql as $f$
begin
  insert into inventory (ingredient_id, quantity_in_stock, last_updated, minimum_stock)
  values (new.ingredient_id, 0, now(), null) on conflict (ingredient_id) do nothing;
  return new;
end $f$;
drop trigger if exists trg_new_ingredient_inventory on ingredients;
create trigger trg_new_ingredient_inventory after insert on ingredients
  for each row execute function brewly_new_ingredient_inventory();

-- average daily usage per ingredient, from the last 28 days of sales data (relative to the newest sale)
create or replace view brewly_avg_daily_usage as
select r.ingredient_id, sum(h.quantity_sold * r.quantity_required) / 28.0 as avg_daily_usage
from "Historical Sales Data" h
join recipes r on r.product_name = h.product_name
where h."date" > (select to_char(max("date")::date - 28, 'YYYY-MM-DD') from "Historical Sales Data")
group by r.ingredient_id;

-- Stock quantities and thresholds are deliberately not repaired here. A sales-derived
-- baseline is only a proposal, not a physical count; apply it separately after owner approval.

-- 7) Sales ingestion: where a sale came from, and idempotency so a POS retry can't double-count
alter table inventory_sales add column if not exists source text not null default 'manual';
alter table inventory_sales add column if not exists external_ref text;
create unique index if not exists inventory_sales_external_ref_uidx
  on inventory_sales (external_ref) where external_ref is not null;

-- 8) Spend policy: separate "auto-order up to" from the daily cap
alter table cafe_spend_policy add column if not exists auto_order_limit numeric not null default 150;
alter table cafe_spend_policy add column if not exists weekly_limit numeric;

-- 9) Agent work queue, owner notification queue (with deferral), one-tap approval links
create table if not exists agent_tasks (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued','running','done','failed','cancelled')),
  run_after timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  dedupe_key text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create unique index if not exists agent_tasks_dedupe_uidx
  on agent_tasks (dedupe_key) where dedupe_key is not null and status in ('queued','running');
alter table public.agent_tasks enable row level security;
revoke all on public.agent_tasks from public, anon, authenticated;
grant select, insert, update on public.agent_tasks to service_role;

create table if not exists owner_notifications (
  id uuid primary key default gen_random_uuid(),
  severity text not null default 'info' check (severity in ('urgent','decision','info')),
  title text not null,
  body text,
  approval_id uuid references approval_inbox(id) on delete set null,
  surface_after timestamptz not null default now(),
  delivered_at timestamptz,
  channel text not null default 'in_app',
  status text not null default 'pending' check (status in ('pending','delivered','dismissed','done')),
  created_at timestamptz not null default now()
);

create table if not exists approval_tokens (
  id uuid primary key default gen_random_uuid(),
  approval_id uuid not null references approval_inbox(id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz
);

alter table agent_activity add column if not exists trigger text;
alter table agent_activity add column if not exists task_id uuid;

-- 10) The app talks to Supabase with the server-side secret key only, so lock the new tables down
alter table cafe_settings enable row level security;
alter table suppliers enable row level security;
alter table agent_tasks enable row level security;
alter table owner_notifications enable row level security;
alter table approval_tokens enable row level security;

create or replace function public.brewly_enqueue_inventory_reconcile()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_task_id uuid;
begin
  if new.kind = 'usage' and left(new.note, 5) = 'Sale ' then
    return new;
  end if;

  insert into public.agent_tasks(kind, payload, dedupe_key)
  values (
    'reconcile_stock',
    jsonb_build_object(
      'movement_id', new.id,
      'ingredient_id', new.ingredient_id,
      'kind', new.kind,
      'amount', new.amount::text
    ),
    'inventory-movement:' || new.id::text
  )
  returning id into v_task_id;

  insert into public.agent_activity(tool, input_summary, outcome, reason, trigger, task_id)
  values (
    'inventory_movement',
    jsonb_build_object('movement_id', new.id, 'ingredient_id', new.ingredient_id)::text,
    'success',
    'Stock movement recorded and queued for reconciliation.',
    'inventory_movement',
    v_task_id
  );
  return new;
end;
$$;
drop trigger if exists trg_enqueue_inventory_reconcile on public.inventory_movements;
create trigger trg_enqueue_inventory_reconcile
after insert on public.inventory_movements
for each row execute function public.brewly_enqueue_inventory_reconcile();

alter table inventory_sales drop constraint if exists inventory_sales_source_check;
alter table inventory_sales add constraint inventory_sales_source_check
  check (source in ('manual', 'pos', 'simulated', 'chat'));

create or replace view public.sales_history with (security_invoker = true) as
select grouped.sales_date, grouped.product_name, grouped.total_units::integer as units_sold,
  grouped.is_public_holiday, 'imported'::text as source
from (
  select valid_rows.sales_date, valid_rows.product_name,
    sum(valid_rows.quantity_sold) as total_units,
    bool_or(coalesce(valid_rows.is_public_holiday, 0) <> 0) as is_public_holiday
  from (
    select public.try_parse_agent_iso_date("date") as sales_date,
      product_name, quantity_sold, is_public_holiday
    from public."Historical Sales Data"
  ) as valid_rows
  where valid_rows.sales_date is not null
    and valid_rows.product_name is not null
    and length(btrim(valid_rows.product_name)) between 1 and 120
    and valid_rows.quantity_sold between 0 and 2147483647
  group by valid_rows.sales_date, valid_rows.product_name
) as grouped
where grouped.total_units between 0 and 2147483647
union all
select recorded.sales_date, recorded.product_name, recorded.total_units::integer as units_sold,
  exists (
    select 1 from public.public_holidays holiday
    where holiday.jurisdiction = 'NSW'
      and holiday.holiday_date = recorded.sales_date
  ) as is_public_holiday,
  case when recorded.has_simulated then 'synthetic_demo' else 'imported' end as source
from (
  select (sale.created_at at time zone 'Australia/Sydney')::date as sales_date,
    sale.product_name,
    sum(sale.quantity) as total_units,
    bool_or(sale.source = 'simulated') as has_simulated
  from public.inventory_sales sale
  group by (sale.created_at at time zone 'Australia/Sydney')::date, sale.product_name
  having sum(sale.quantity) between 0 and 2147483647
) as recorded;

create or replace view public.brewly_avg_daily_usage as
with latest_sale as (
  select max(sales_date) as sale_date
  from public.sales_history
)
select recipe.ingredient_id,
  sum(history.units_sold * recipe.quantity_required) / 28.0 as avg_daily_usage
from public.sales_history history
join public.recipes recipe on recipe.product_name = history.product_name
cross join latest_sale
where history.sales_date > latest_sale.sale_date - 28
  and history.sales_date <= latest_sale.sale_date
group by recipe.ingredient_id;
revoke all on public.brewly_avg_daily_usage from public, anon, authenticated;
grant select on public.brewly_avg_daily_usage to service_role;

create table if not exists public.pos_sales_events (
  external_ref text primary key check (length(btrim(external_ref)) between 1 and 120),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.pos_sales_events enable row level security;
revoke all on public.pos_sales_events from public, anon, authenticated;
grant select, insert on public.pos_sales_events to service_role;

create or replace function public.record_inventory_sale_with_source(
  p_request_id uuid,
  p_product_name text,
  p_quantity integer,
  p_source text,
  p_external_ref text default null,
  p_occurred_at timestamptz default null
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.inventory_sales%rowtype;
  v_result jsonb;
  v_replayed boolean := false;
  v_task_id uuid;
begin
  if p_source is null or p_source not in ('manual', 'pos', 'simulated', 'chat')
    or (p_external_ref is not null and length(btrim(p_external_ref)) not between 1 and 120)
    or (p_source in ('pos', 'simulated') and p_external_ref is null)
    or (p_source = 'pos' and p_occurred_at is null) then
    raise exception 'INVALID_SALE_SOURCE';
  end if;

  if p_external_ref is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended('inventory-sale-ref:' || p_external_ref, 0)
    );
    select * into v_existing
    from public.inventory_sales
    where external_ref = p_external_ref;
    if found then
      if v_existing.product_name is distinct from p_product_name
        or v_existing.quantity is distinct from p_quantity
        or v_existing.source is distinct from p_source
        or (p_occurred_at is not null and v_existing.created_at is distinct from p_occurred_at) then
        raise exception 'SALE_EXTERNAL_REF_CONFLICT';
      end if;
      select jsonb_build_object(
        'sale_id', s.id,
        'product_name', s.product_name,
        'quantity', s.quantity,
        'replayed', true,
        'changes', (
          select jsonb_agg(jsonb_build_object(
            'ingredient_id', i.ingredient_id::text,
            'name', i.ingredient_name,
            'unit', i.unit,
            'amount', i.amount::text,
            'before', i.quantity_before::text,
            'after', i.quantity_after::text
          ) order by i.ingredient_id)
          from public.inventory_sale_ingredients i
          where i.sale_id = s.id
        )
      ) into v_result
      from public.inventory_sales s
      where s.id = v_existing.id;
      return v_result;
    end if;
  end if;

  select * into v_existing
  from public.inventory_sales
  where id = p_request_id;
  if found and (
    v_existing.product_name is distinct from p_product_name
    or v_existing.quantity is distinct from p_quantity
    or v_existing.source is distinct from p_source
    or v_existing.external_ref is distinct from p_external_ref
  ) then
    raise exception 'SALE_REQUEST_CONFLICT';
  end if;
  if found then v_replayed := true; end if;

  v_result := public.record_inventory_sale(p_request_id, p_product_name, p_quantity);
  update public.inventory_sales
  set source = p_source,
      external_ref = p_external_ref,
      created_at = coalesce(p_occurred_at, created_at)
  where id = p_request_id;
  if not v_replayed then
    insert into public.agent_tasks(kind, payload, dedupe_key)
    values (
      'reconcile_stock',
      jsonb_build_object('sale_id', p_request_id, 'source', p_source),
      'reconcile-sale:' || p_request_id::text
    )
    returning id into v_task_id;
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger, task_id)
    values (
      'record_sale',
      jsonb_build_object(
        'sale_id', p_request_id,
        'product_name', p_product_name,
        'quantity', p_quantity,
        'source', p_source
      )::text,
      'success',
      'Sale recorded and queued for stock reconciliation.',
      case p_source when 'pos' then 'pos_webhook'
        when 'chat' then 'owner_chat'
        when 'simulated' then 'sales_simulator'
        else 'manual_sale' end,
      v_task_id
    );
  end if;
  return v_result;
end;
$$;

create or replace function public.record_pos_sales_event(
  p_external_ref text,
  p_occurred_at timestamptz,
  p_items jsonb,
  p_payload_hash text
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_existing public.pos_sales_events%rowtype;
  v_item record;
  v_index integer := 0;
  v_sales jsonb := '[]'::jsonb;
  v_sale jsonb;
  v_result jsonb;
begin
  if p_external_ref is null or length(btrim(p_external_ref)) not between 1 and 116
    or p_occurred_at is null
    or p_payload_hash is null or p_payload_hash !~ '^[0-9a-f]{64}$'
    or p_items is null or jsonb_typeof(p_items) <> 'array' then
    raise exception 'INVALID_POS_SALE';
  end if;
  if jsonb_array_length(p_items) not between 1 and 100 then
    raise exception 'INVALID_POS_SALE';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_items) as entry(value)
    where jsonb_typeof(entry.value) <> 'object'
      or jsonb_typeof(entry.value -> 'product_name') <> 'string'
      or length(btrim(entry.value ->> 'product_name')) not between 1 and 120
      or jsonb_typeof(entry.value -> 'quantity') <> 'number'
      or (entry.value ->> 'quantity') !~ '^[1-9][0-9]*$'
      or length(entry.value ->> 'quantity') > 4
      or case
        when (entry.value ->> 'quantity') ~ '^[1-9][0-9]*$'
          and length(entry.value ->> 'quantity') <= 4
          then (entry.value ->> 'quantity')::integer not between 1 and 1000
        else true
      end
  ) then
    raise exception 'INVALID_POS_SALE';
  end if;

  if exists (
    select entry.value ->> 'product_name'
    from jsonb_array_elements(p_items) as entry(value)
    group by entry.value ->> 'product_name'
    having count(*) > 1
  ) then
    raise exception 'DUPLICATE_POS_PRODUCT';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('pos-event:' || p_external_ref, 0)
  );
  select * into v_existing
  from public.pos_sales_events
  where external_ref = p_external_ref;
  if found then
    if v_existing.payload_hash is distinct from p_payload_hash then
      raise exception 'POS_EVENT_CONFLICT';
    end if;
    return v_existing.result || jsonb_build_object('replayed', true);
  end if;

  for v_item in
    select product_name, quantity
    from jsonb_to_recordset(p_items) as x(product_name text, quantity integer)
    order by product_name
  loop
    v_index := v_index + 1;
    v_sale := public.record_inventory_sale_with_source(
      gen_random_uuid(),
      v_item.product_name,
      v_item.quantity,
      'pos',
      p_external_ref || ':' || v_index::text,
      p_occurred_at
    );
    v_sales := v_sales || jsonb_build_array(v_sale);
  end loop;

  v_result := jsonb_build_object(
    'external_ref', p_external_ref,
    'occurred_at', p_occurred_at,
    'sales', v_sales,
    'replayed', false
  );
  insert into public.pos_sales_events(external_ref, payload_hash, result)
  values (p_external_ref, p_payload_hash, v_result);

  return v_result;
end;
$$;

create or replace function public.record_inventory_count(
  p_ingredient_id bigint,
  p_counted_quantity numeric,
  p_expected_updated timestamptz,
  p_note text
) returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_stock numeric;
  v_updated timestamptz;
  v_amount numeric;
  v_counted_at timestamptz := clock_timestamp();
begin
  if p_ingredient_id is null
    or p_counted_quantity is null or p_counted_quantity < 0 or p_counted_quantity > 1000000000
    or p_counted_quantity::text in ('NaN', 'Infinity', '-Infinity')
    or p_counted_quantity <> trunc(p_counted_quantity, 6)
    or p_expected_updated is null
    or p_note is null or length(btrim(p_note)) not between 1 and 200 then
    raise exception 'INVALID_INVENTORY_COUNT';
  end if;

  select quantity_in_stock, last_updated
  into v_stock, v_updated
  from public.inventory
  where ingredient_id = p_ingredient_id
  for update;
  if not found then raise exception 'NO_STOCK_RECORD'; end if;
  if v_updated is distinct from p_expected_updated then raise exception 'STALE_STOCK'; end if;
  if v_stock is null or v_stock < 0 or v_stock::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'INVALID_STOCK';
  end if;

  v_amount := abs(p_counted_quantity - v_stock);
  update public.inventory
  set quantity_in_stock = p_counted_quantity,
      last_updated = case when v_amount > 0
        then greatest(v_counted_at, v_updated + interval '1 millisecond')
        else v_updated
      end,
      last_counted_at = v_counted_at
  where ingredient_id = p_ingredient_id;

  if v_amount > 0 then
    insert into public.inventory_movements(
      ingredient_id, kind, amount, quantity_before, quantity_after, note
    ) values (
      p_ingredient_id, 'adjustment', v_amount, v_stock, p_counted_quantity, btrim(p_note)
    );
  end if;

  if v_amount = 0 then
    insert into public.agent_activity(tool, input_summary, outcome, reason, trigger)
    values (
      'inventory_count',
      jsonb_build_object('ingredient_id', p_ingredient_id, 'counted_quantity', p_counted_quantity)::text,
      'success',
      btrim(p_note),
      'owner_count'
    );
  end if;
  return p_counted_quantity;
end;
$$;

revoke all on function public.record_inventory_sale_with_source(uuid, text, integer, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_inventory_sale_with_source(uuid, text, integer, text, text, timestamptz)
  to service_role;
grant update on public.inventory_sales to service_role;
revoke all on function public.brewly_enqueue_inventory_reconcile()
  from public, anon, authenticated;
grant execute on function public.brewly_enqueue_inventory_reconcile()
  to service_role;
revoke all on function public.record_pos_sales_event(text, timestamptz, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.record_pos_sales_event(text, timestamptz, jsonb, text)
  to service_role;
revoke all on function public.record_inventory_count(bigint, numeric, timestamptz, text)
  from public, anon, authenticated;
grant execute on function public.record_inventory_count(bigint, numeric, timestamptz, text)
  to service_role;
