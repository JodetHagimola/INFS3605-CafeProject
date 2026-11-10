-- Canonical receipt adapter: incoming quantity is the original ordered amount.
begin;
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

commit;
