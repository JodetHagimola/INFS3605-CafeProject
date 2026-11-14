-- Apply after cafe-operations-agent.sql. No stock, rules or orders are seeded.
begin;
create table if not exists public.cafe_sensor_events (
  id uuid primary key, delivery_id bigint not null references public.incoming_deliveries,
  measured numeric not null, expected_before numeric not null, unit text not null, final_arrival boolean not null,
  receipt_id uuid not null unique references public.delivery_receipts,
  outcome text not null check(outcome in ('complete','partial','short','extra')),
  created_at timestamptz not null default now()
);
create table if not exists public.cafe_test_mail (
  event_id uuid primary key references public.cafe_sensor_events,
  facts jsonb not null, payload jsonb, channel text check(channel in ('inbox','resend')),
  status text not null default 'queued' check(status in ('queued','delivered_to_demo','provider_accepted','check_delivery')),
  started_at timestamptz, sent_at timestamptz, provider_id text,
  retry_at timestamptz not null default now(), last_error text
);

create or replace function public.apply_sensor_reading(p_event uuid,p_delivery bigint,p_measured numeric,
  p_expected numeric,p_unit text,p_final boolean) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare
  previous public.cafe_sensor_events%rowtype;
  d public.incoming_deliveries%rowtype;
  balance numeric; shortage numeric; receipt uuid; outcome text; activity bigint;
  updated timestamptz; ref text; ingredient text;
begin
  if p_event is null or p_final is null or p_unit is null or p_delivery is null
    or p_measured is null or not (p_measured>0 and p_measured<=1000000000 and p_measured=trunc(p_measured,6))
    or p_expected is null or not(p_expected>0 and p_expected<=1000000000) then raise exception 'INVALID_READING'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event::text,1));
  select * into previous from public.cafe_sensor_events where id=p_event;
  if found then
    if (previous.delivery_id,previous.measured,previous.expected_before,previous.unit,previous.final_arrival)
      is distinct from (p_delivery,p_measured,p_expected,p_unit,p_final) then raise exception 'EVENT_CONFLICT'; end if;
    return jsonb_build_object('outcome',previous.outcome,'receipt',previous.receipt_id,'replayed',true);
  end if;
  select * into strict d from public.incoming_deliveries where delivery_id=p_delivery for update;
  if d.stock_unit is distinct from p_unit then raise exception 'UNIT_MISMATCH'; end if;
  select outstanding_quantity::numeric into balance from public.open_delivery_balances where delivery_id=p_delivery;
  if balance is distinct from p_expected then raise exception 'DELIVERY_CHANGED'; end if;
  shortage := balance-p_measured;
  if shortage < 0 then
    insert into public.agent_activity(tool,input_summary,outcome,reason)
      values('sensor_delivery',p_event::text,'started','Simulated scanner') returning id into activity;
    select last_updated into updated from public.inventory where ingredient_id=d.ingredient_id for update;
    perform public.record_agent_delivery_receipt(activity,p_delivery,p_measured,updated,'Simulated sensor '||p_event);
    select id into strict receipt from public.delivery_receipts where agent_activity_id=activity;
    update public.agent_activity set outcome='success',reason='Extra goods received; supplier follow-up queued.' where id=activity;
    outcome:='extra';
  else
    perform public.receive_classified_delivery(p_event,p_delivery,p_measured,p_expected,'Simulated sensor '||p_event,p_final);
    receipt:=p_event;
    outcome:=case when shortage=0 then 'complete' when p_final then 'short' else 'partial' end;
  end if;
  insert into public.cafe_sensor_events(id,delivery_id,measured,expected_before,unit,final_arrival,receipt_id,outcome)
    values(p_event,p_delivery,p_measured,p_expected,p_unit,p_final,receipt,outcome);
  if outcome in ('short','extra') then
    select supplier_reference into ref from public.delivery_batches where id=d.batch_id;
    select ingredient_name into strict ingredient from public.delivery_receipts where id=receipt;
    insert into public.cafe_test_mail(event_id,facts) values(p_event,jsonb_build_object(
      'receipt',receipt,'kind',outcome,'reference',coalesce(ref,d.demo_key,'Delivery #'||p_delivery),
      'ingredient',ingredient,'supplier',d.supplier_name,'ordered',d.quantity::text,
      'received',(d.quantity-shortage)::text,'difference',abs(shortage)::text,'unit',p_unit));
  end if;
  return jsonb_build_object('outcome',outcome,'receipt',receipt,'replayed',false);
end $$;

-- Freeze one recipient, subject and body for all attempts. Concurrent sends share a provider key.
create or replace function public.prepare_cafe_test_mail(p_event uuid,p_channel text,p_payload jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare m public.cafe_test_mail%rowtype;
begin
  select * into strict m from public.cafe_test_mail where event_id=p_event for update;
  if m.payload is null then
    update public.cafe_test_mail set payload=p_payload,channel=p_channel,started_at=clock_timestamp()
      where event_id=p_event returning * into m;
  end if;
  return to_jsonb(m);
end $$;

create table if not exists public.cafe_spend_policy (
  id integer primary key check(id=1), daily_limit numeric not null check(daily_limit between 0.01 and 1000000)
);
insert into public.cafe_spend_policy values(1,100) on conflict do nothing;
create table if not exists public.cafe_reorder_rules (
  ingredient_id bigint primary key references public.inventory(ingredient_id), supplier text not null,
  packs integer not null check(packs between 1 and 10000),
  order_limit numeric not null check(order_limit between 0.01 and 1000000),
  enabled boolean not null default true
);
create table if not exists public.cafe_sim_orders (
  id uuid primary key default gen_random_uuid(), movement_id bigint not null unique references public.inventory_movements,
  ingredient_id bigint not null references public.inventory(ingredient_id), ingredient text not null,
  supplier text not null, packs integer not null, stock_amount numeric not null, unit text not null,
  total numeric, status text not null check(status in ('pending','submitted','rejected','blocked')),
  reason text not null, delivery_id bigint unique references public.incoming_deliveries,
  submitted_at timestamptz, created_at timestamptz not null default now()
);
create unique index if not exists cafe_one_pending_order on public.cafe_sim_orders(ingredient_id) where status='pending';

create or replace function public.configure_cafe_reorder(p_ingredient bigint,p_supplier text,p_packs integer,
 p_order_limit numeric,p_daily_limit numeric,p_enabled boolean,p_minimum numeric default null) returns void language plpgsql security invoker set search_path='' as $$
begin
  if not exists(select 1 from public.supplier_prices where ingredient_id=p_ingredient and supplier=p_supplier) then
    raise exception 'UNKNOWN_SUPPLIER'; end if;
  if p_minimum is not null then
    if not (p_minimum between 0 and 1000000000) then raise exception 'INVALID_STOCK_MINIMUM'; end if;
    update public.inventory set minimum_stock=p_minimum where ingredient_id=p_ingredient;
  end if;
  update public.cafe_spend_policy set daily_limit=p_daily_limit where id=1;
  insert into public.cafe_reorder_rules values(p_ingredient,p_supplier,p_packs,p_order_limit,p_enabled)
  on conflict(ingredient_id) do update set supplier=excluded.supplier,packs=excluded.packs,
    order_limit=excluded.order_limit,enabled=excluded.enabled;
end $$;

-- A simulated supplier acknowledges once and registers tomorrow's expected delivery.
create or replace function public.submit_cafe_sim_order(p_id uuid,p_reason text) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.cafe_sim_orders%rowtype; arriving bigint;
begin
  select * into strict o from public.cafe_sim_orders where id=p_id for update;
  if o.status='submitted' then return; end if;
  if o.status<>'pending' or o.total is null then raise exception 'ORDER_NOT_PENDING'; end if;
  insert into public.incoming_deliveries(ingredient_id,quantity,ordered_quantity,stock_unit,supplier_name,expected_date,demo_key)
    values(o.ingredient_id,o.stock_amount,o.stock_amount,o.unit,o.supplier,(now() at time zone 'Australia/Sydney')::date+1,'SIM-'||o.id)
    returning delivery_id into arriving;
  update public.cafe_sim_orders set status='submitted',reason=p_reason,delivery_id=arriving,submitted_at=clock_timestamp() where id=o.id;
end $$;

create or replace function public.evaluate_cafe_reorder() returns trigger
language plpgsql security invoker set search_path='' as $$
declare
  r public.cafe_reorder_rules%rowtype; threshold numeric; incoming numeric; daily_cap numeric;
  n text; u text; pack_size integer; price numeric; min_packs numeric; quotes integer;
  total_cost numeric; spent numeric; reason text; order_id uuid;
begin
  if new.kind not in ('usage','waste') then return new; end if;
  if not exists(select 1 from public.cafe_reorder_rules where ingredient_id=new.ingredient_id and enabled) then return new; end if;
  select daily_limit into daily_cap from public.cafe_spend_policy where id=1 for update;
  select * into r from public.cafe_reorder_rules where ingredient_id=new.ingredient_id and enabled;
  if not found then return new; end if;
  select i.minimum_stock,g.ingredient_name,g.unit into threshold,n,u
    from public.inventory i join public.ingredients g using(ingredient_id) where i.ingredient_id=new.ingredient_id;
  if threshold is null or new.quantity_after>threshold then return new; end if;
  if exists(select 1 from public.cafe_sim_orders where ingredient_id=new.ingredient_id and status='pending') then return new; end if;
  select coalesce(sum(outstanding_quantity::numeric),0) into incoming from public.open_delivery_balances
    where ingredient_id=new.ingredient_id;
  if incoming>0 and new.quantity_after+incoming>=threshold then return new; end if;
  pack_size:=case lower(u) when 'ml' then 1000 when 'g' then 1000 when 'pcs' then 1 end;
  select count(*),min(p.price),min(p.minimum_order) into quotes,price,min_packs
    from public.supplier_prices p where p.ingredient_id=r.ingredient_id and p.supplier=r.supplier;
  if quotes<>1 or pack_size is null or min_packs is null or r.packs<min_packs or price is null or not(price>0 and price<=1000000) then
    reason:='Check supplier price, pack unit or supplier minimum';
  else
    total_cost:=round(r.packs*price,2);
    if total_cost<=0 then total_cost:=null; reason:='Check supplier price'; end if;
  end if;
  select coalesce(sum(total),0) into spent from public.cafe_sim_orders where status='submitted'
    and (submitted_at at time zone 'Australia/Sydney')::date=(clock_timestamp() at time zone 'Australia/Sydney')::date;
  if reason is null then
    reason:=case when total_cost>=r.order_limit then 'Owner approval: per-order limit'
      when spent+total_cost>daily_cap then 'Owner approval: daily budget'
      else 'Within supplier and budget rule' end;
  end if;
  insert into public.cafe_sim_orders(movement_id,ingredient_id,ingredient,supplier,packs,stock_amount,unit,total,status,reason)
    values(new.id,r.ingredient_id,n,r.supplier,r.packs,r.packs*coalesce(pack_size,0),u,total_cost,
      case when total_cost is null then 'blocked' else 'pending' end,reason) returning id into order_id;
  if reason='Within supplier and budget rule' then perform public.submit_cafe_sim_order(order_id,reason); end if;
  return new;
end $$;
drop trigger if exists cafe_evaluate_movement on public.inventory_movements;
create trigger cafe_evaluate_movement after insert on public.inventory_movements for each row execute function public.evaluate_cafe_reorder();

create or replace function public.review_cafe_sim_order(p_id uuid,p_approve boolean) returns void
language plpgsql security invoker set search_path='' as $$
declare o public.cafe_sim_orders%rowtype; q numeric; threshold numeric; incoming numeric;
begin
  if p_approve is null then raise exception 'DECISION_REQUIRED'; end if;
  perform 1 from public.cafe_spend_policy where id=1 for update;
  select * into strict o from public.cafe_sim_orders where id=p_id for update;
  if o.status<>'pending' then return; end if;
  if not p_approve then
    update public.cafe_sim_orders set status='rejected',reason='Owner declined' where id=p_id; return;
  end if;
  select quantity_in_stock,minimum_stock into q,threshold from public.inventory where ingredient_id=o.ingredient_id;
  select coalesce(sum(outstanding_quantity::numeric),0) into incoming from public.open_delivery_balances where ingredient_id=o.ingredient_id;
  if q is null or threshold is null or q>threshold or (incoming>0 and q+incoming>=threshold)
    or not exists(select 1 from public.cafe_reorder_rules where ingredient_id=o.ingredient_id and enabled and supplier=o.supplier and packs=o.packs)
    or (select count(*) from public.supplier_prices where ingredient_id=o.ingredient_id and supplier=o.supplier)<>1
    or not exists(select 1 from public.supplier_prices where ingredient_id=o.ingredient_id and supplier=o.supplier
      and round(price*o.packs,2)=o.total and minimum_order<=o.packs) then
    update public.cafe_sim_orders set status='blocked',reason='Stock, rule or supplier quote changed; reevaluate on the next usage.' where id=p_id; return;
  end if;
  perform public.submit_cafe_sim_order(p_id,'Owner approved');
end $$;

do $$
declare t text; f text;
begin
  foreach t in array array['cafe_sensor_events','cafe_test_mail','cafe_spend_policy','cafe_reorder_rules','cafe_sim_orders'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select,insert,update on public.%I to service_role',t);
  end loop;
  foreach f in array array['apply_sensor_reading(uuid,bigint,numeric,numeric,text,boolean)','prepare_cafe_test_mail(uuid,text,jsonb)',
    'configure_cafe_reorder(bigint,text,integer,numeric,numeric,boolean,numeric)','submit_cafe_sim_order(uuid,text)',
    'evaluate_cafe_reorder()','review_cafe_sim_order(uuid,boolean)'] loop
    execute 'revoke all on function public.'||f||' from public,anon,authenticated';
    execute 'grant execute on function public.'||f||' to service_role';
  end loop;
end $$;
commit;
