-- Run manually after inventory-feature.sql and agent-read-only-tools.sql.
-- These functions append movement/receipt records and update inventory only
-- through the guarded record_inventory_movement function.
begin;

create table if not exists public.agent_inventory_actions (
  activity_id bigint primary key references public.agent_activity(id),
  quantity_after numeric not null check (quantity_after >= 0),
  created_at timestamptz not null default clock_timestamp()
);

alter table public.agent_inventory_actions enable row level security;
revoke all on table public.agent_inventory_actions from public, anon, authenticated;
grant select, insert on table public.agent_inventory_actions to service_role;

create or replace function public.record_agent_inventory_movement(
  p_activity_id bigint,
  p_ingredient_id bigint,
  p_kind text,
  p_amount numeric,
  p_expected_updated timestamptz,
  p_note text
) returns numeric
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_quantity numeric;
begin
  if p_kind is null or p_kind not in ('waste', 'delivery') then
    raise exception 'INVALID_AGENT_MOVEMENT';
  end if;

  perform 1 from public.agent_activity where id = p_activity_id for update;
  if not found then raise exception 'NO_ACTIVITY_RECORD'; end if;

  select quantity_after into v_quantity
    from public.agent_inventory_actions where activity_id = p_activity_id;
  if found then return v_quantity; end if;

  v_quantity := public.record_inventory_movement(
    p_ingredient_id, p_kind, p_amount, p_expected_updated, p_note
  );
  insert into public.agent_inventory_actions(activity_id, quantity_after)
    values (p_activity_id, v_quantity);
  return v_quantity;
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
  v_existing_quantity numeric;
  v_stock numeric;
begin
  if p_received_quantity is null or p_received_quantity <= 0
    or p_received_quantity > 1000000000
    or p_received_quantity::text in ('NaN', 'Infinity', '-Infinity')
    or p_received_quantity <> trunc(p_received_quantity, 6) then
    raise exception 'INVALID_RECEIVED_QUANTITY';
  end if;

  perform 1 from public.agent_activity where id = p_activity_id for update;
  if not found then raise exception 'NO_ACTIVITY_RECORD'; end if;

  select inventory.quantity_in_stock into v_stock
    from public.delivery_receipts as receipt
    join public.incoming_deliveries as delivery using (delivery_id)
    join public.inventory as inventory using (ingredient_id)
    where receipt.agent_activity_id = p_activity_id;
  if found then return v_stock; end if;

  select ingredient_id into v_ingredient_id
    from public.incoming_deliveries
    where delivery_id = p_delivery_id
    for update;
  if not found then raise exception 'NO_INCOMING_DELIVERY'; end if;

  v_stock := public.record_inventory_movement(
    v_ingredient_id, 'delivery', p_received_quantity, p_expected_updated, p_note
  );
  insert into public.delivery_receipts(
    delivery_id, received_quantity, note, agent_activity_id
  ) values (
    p_delivery_id, p_received_quantity, trim(p_note), p_activity_id
  );
  return v_stock;
end;
$$;

revoke all on function public.record_agent_inventory_movement(bigint,bigint,text,numeric,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.record_agent_inventory_movement(bigint,bigint,text,numeric,timestamptz,text)
  to service_role;

revoke all on function public.record_agent_delivery_receipt(bigint,bigint,numeric,timestamptz,text)
  from public, anon, authenticated;
grant execute on function public.record_agent_delivery_receipt(bigint,bigint,numeric,timestamptz,text)
  to service_role;

commit;
